// Demo AI agent on a leash, one command.
//
//   npx tsx scripts/agent.ts                  offline: mock network that runs the real covenant (no keys, no coins)
//   npx tsx scripts/agent.ts --net chipnet    real chipnet transactions from the PUBLIC demo leash (its agent key
//                                             is published in web/src/demo.json; nothing secret is needed)
// Options:
//   --goal "<text>"    what the agent should do (default: brief on BCH, then keep watching the chain tip)
//   --scripted         force the deterministic planner even if an LLM is configured
//   --no-attack        skip phase 2 (compromised agent)
//   --steps <n>        planner step cap (default 8)
// LLM planner (optional, any OpenAI-compatible endpoint), from the environment:
//   AGENT_LLM_BASE_URL  e.g. https://integrate.api.nvidia.com/v1  or  https://api.groq.com/openai/v1
//   AGENT_LLM_API_KEY   your key (never logged)
//   AGENT_LLM_MODEL     e.g. openai/gpt-oss-20b (NVIDIA NIM), llama-3.3-70b-versatile (Groq)
//   AGENT_LLM_MAX_TOKENS optional, default 4000 (reasoning models think before they answer)
//
// Phase 1: the agent runs its own tool server (the 402 paywall, src/http.ts) on 127.0.0.1 and pays every tool
// call from the leash over HTTP: 402 -> covenant payment with an on-chain receipt -> 200 + txid. When the next
// call would break the window, its own SDK refuses before signing.
// Phase 2: the agent is "compromised" and ignores the SDK: it signs raw transactions that break the rules and
// broadcasts them. The network refuses; the verbatim refusal goes into the journal.
// Chipnet runs are appended to scripts/agent-chipnet-log.jsonl. Mainnet is refused here on purpose.
import { appendFileSync, readFileSync } from 'fs';
import type { AddressInfo } from 'node:net';
import { encodeCashAddress, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo, type SpendableUtxo } from 'cashscript';
import {
  AgentLeash, ATTACKS, DEMO_GOAL, DEMO_TOOLS, ELECTRUM_HOSTS, FailoverProvider, LeashPaywall, LlmPlanner, compromisedProbe, demoPlanner, demoRoutes,
  encodeState, p2pkhLock, pkhOfPrivateKey, runAgent, servePaywall, type AgentEvent, type AttackKind, type LeashParams, type Planner,
} from '../src/index.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n) || args.some((a) => a.startsWith(`${n}=`));
const opt = (n: string) => {
  const eq = args.find((a) => a.startsWith(`${n}=`));
  if (eq) return eq.slice(n.length + 1); // keeps any '=' inside the value (e.g. a goal)
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const NET = opt('--net') ?? 'mock';
if (NET === 'mainnet') {
  console.error('refusing: this demo agent does not run on mainnet. The capped mainnet run is scripts/net-run.ts and needs the owner\'s approval.');
  process.exit(1);
}
if (NET !== 'mock' && NET !== 'chipnet') { console.error(`unknown --net ${NET} (mock | chipnet)`); process.exit(1); }

const sats = (n: bigint | number) => `${Number(n).toLocaleString('en-US')} sats`;
const explorer = (txid: string) => `https://chipnet.chaingraph.cash/tx/${txid}`;
const LOG = new URL('./agent-chipnet-log.jsonl', import.meta.url);
const runId = new Date().toISOString();
const json = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const record = (e: Record<string, unknown>) => { if (NET === 'chipnet') appendFileSync(LOG, json({ run: runId, ...e }) + '\n'); };

function show(e: AgentEvent) {
  const tag: Record<string, string> = { start: 'START', plan: 'PLAN ', challenge: '402  ', paid: 'PAID ', refused: 'NO   ', failed: 'FAIL ', finish: 'DONE ', attack: 'ATTACK' };
  let line = `${tag[e.kind]} ${e.step ? `#${e.step} ` : ''}${e.text}`;
  if (e.kind === 'plan' && e.budget) line += `   [window: ${sats(e.budget.spent)} of ${sats(e.budget.limit)} spent, ${sats(e.budget.left)} left]`;
  if (e.kind === 'paid' && e.txid) line += `\n        tx ${e.txid}${NET === 'chipnet' ? `\n        ${explorer(e.txid)}` : ''}\n        answer ${e.body}`;
  if (e.kind === 'refused' && e.by) line = `${tag.refused} #${e.step} refused by ${e.by.toUpperCase()}: ${e.reason}`;
  if (e.kind === 'attack') line = e.accepted
    ? `ATTACK ${e.text}`
    : `ATTACK ${e.text}${e.reason ? `\n        ${NET === 'mock' ? 'mock network (BCH VM)' : 'node'}: ${e.reason}` : ''}${e.rule ? `\n        contract rule: "${e.rule}"` : e.attack ? `\n        ${ATTACKS[e.attack].rule}` : ''}`;
  console.log(line);
  record({ ...e, body: e.body?.slice(0, 300) });
}

// ---------- the leash, the provider, the tool payee ----------
let leash: AgentLeash;
let agentPriv: Uint8Array;
let payTo: string;
let provider: MockNetworkProvider | FailoverProvider;
let network: 'bch:bchtest';
let attackKinds: AttackKind[];
let stateUtxo: (afterTxid?: string) => Promise<SpendableUtxo>;
let ageOf: (u: SpendableUtxo) => Promise<bigint>;

if (NET === 'mock') {
  const mock = new MockNetworkProvider();
  provider = mock;
  const key = () => generatePrivateKey();
  const addr = (priv: Uint8Array) => { const r = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkhOfPrivateKey(priv) }); return typeof r === 'string' ? r : r.address; };
  const ownerPriv = key(), toolPriv = key();
  agentPriv = key();
  payTo = addr(toolPriv);
  const params: LeashParams = {
    stateCategory: Buffer.from(key()).toString('hex'), agentPkh: pkhOfPrivateKey(agentPriv), ownerLock: p2pkhLock(pkhOfPrivateKey(ownerPriv)),
    allow: [p2pkhLock(pkhOfPrivateKey(toolPriv))], limit: 12_000n, period: 6n, maxFee: 2_000n,
  };
  leash = new AgentLeash(params, mock);
  mock.addUtxo(leash.tokenAddress, { ...randomUtxo({ satoshis: 100_000n }), token: { category: params.stateCategory, amount: 0n, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 0n, spent: 0n }) } } });
  // the mock does not model BIP68, so the clock attack is left to chipnet
  attackKinds = ['recipient', 'overspend', 'fee', 'fakereset'];
  stateUtxo = async () => { const { state } = await leash.getUtxos(); if (!state) throw new Error('no state coin'); return state; };
  ageOf = async () => 0n;
  console.log('Network: MOCK (CashScript MockNetworkProvider: every broadcast runs the real covenant in the BCH VM; no real coins).');
} else {
  provider = new FailoverProvider('chipnet' as any, ELECTRUM_HOSTS.chipnet, { onSwitch: (f, t, why) => console.log(`(electrum: ${f} -> ${t}: ${why.split('\n')[0]})`) });
  const d = JSON.parse(readFileSync(new URL('../web/src/demo.json', import.meta.url), 'utf8')).chipnet;
  if (!d?.publicDemo || !d.agentPriv) throw new Error('web/src/demo.json has no public chipnet demo leash');
  const params: LeashParams = { stateCategory: d.stateCategory, agentPkh: hexToBin(d.agentPkh), ownerLock: hexToBin(d.ownerLock), allow: d.allow.map(hexToBin), limit: BigInt(d.limit), period: BigInt(d.period), maxFee: BigInt(d.maxFee) };
  leash = new AgentLeash(params, provider);
  agentPriv = hexToBin(d.agentPriv);
  const r = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: params.allow[0].slice(3, 23) });
  payTo = typeof r === 'string' ? r : r.address;
  attackKinds = ['recipient', 'overspend', 'clock'];
  const p = provider;
  stateUtxo = async (afterTxid) => {
    for (let i = 0; i < 40; i++) {
      const { state } = await leash.getUtxos();
      if (state && (!afterTxid || state.txid === afterTxid)) return state;
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error(`state coin ${afterTxid ?? ''} not visible after 60 s`);
  };
  ageOf = async (u) => {
    const tip = await p.getBlockHeight();
    const { sha256, binToHex } = await import('@bitauth/libauth');
    const list = await p.performRequest('blockchain.scripthash.listunspent', binToHex(sha256.hash(hexToBin(u.lockingBytecode)).reverse())) as any[];
    const row = list.find((x) => x.tx_hash === u.txid && x.tx_pos === u.vout);
    if (!row || row.height <= 0) return 0n;
    const age = BigInt(tip + 1 - row.height);
    return age > 65535n ? 65535n : age;
  };
  console.log(`Network: CHIPNET (real transactions). Public demo leash ${leash.tokenAddress}`);
}
network = 'bch:bchtest';

// ---------- planner ----------
const llm = process.env.AGENT_LLM_API_KEY && process.env.AGENT_LLM_BASE_URL && process.env.AGENT_LLM_MODEL && !flag('--scripted');
const planner: Planner = llm
  ? new LlmPlanner({
    baseUrl: process.env.AGENT_LLM_BASE_URL!, apiKey: process.env.AGENT_LLM_API_KEY!, model: process.env.AGENT_LLM_MODEL!,
    maxTokens: process.env.AGENT_LLM_MAX_TOKENS ? Number(process.env.AGENT_LLM_MAX_TOKENS) : 4000, timeoutMs: 60_000,
  })
  : demoPlanner();
const goal = opt('--goal') ?? DEMO_GOAL;

// ---------- tool server: the 402 paywall over real HTTP on 127.0.0.1 ----------
const paywall = new LeashPaywall({
  network, payTo, origin: 'http://127.0.0.1', provider,
  routes: demoRoutes({ provider, networkName: NET === 'mock' ? 'mocknet' : 'chipnet', ...(NET === 'mock' ? { price: async () => 300, priceLabel: 'mock (fixed, not a market price)' } : {}) }),
});
const server = await servePaywall(paywall, 0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const rules = leash.params;
console.log(`Leash rules (enforced by the covenant): at most ${sats(rules.limit)} per ${rules.period} blocks incl. fees, fee <= ${sats(rules.maxFee)}, only to ${payTo}`);
console.log(`Tool server: ${base} (402 paywall, payee ${payTo})`);
console.log(`Planner: ${planner.name}\n`);
record({ kind: 'run', net: NET, planner: planner.name, goal, leash: leash.tokenAddress, payTo, rules: { limit: rules.limit, period: rules.period, maxFee: rules.maxFee } });

let breach = false;
try {
  console.log('--- Phase 1: the agent works (and pays) ---');
  const r = await runAgent({
    goal, tools: DEMO_TOOLS, planner, baseUrl: base, leash, agentPrivateKey: agentPriv, network, maxPrice: 5_000n,
    stateUtxo, elapsedAdd: ageOf, maxSteps: Number(opt('--steps') ?? 8), on: show,
  });
  const paid = r.calls.filter((c) => c.outcome === 'paid');
  console.log(`\nAnswer: ${r.answer}`);
  console.log(`Paid ${paid.length} call(s), ${sats(r.paid)} to the tool (+ miner fees, also counted by the covenant).`);

  if (!flag('--no-attack')) {
    console.log('\n--- Phase 2: the agent is compromised and ignores its SDK ---');
    const st = await stateUtxo(paid[paid.length - 1]?.txid);
    const res = await compromisedProbe({
      leash, stateUtxo: st, agentPrivateKey: agentPriv, realAge: await ageOf(st), kinds: attackKinds,
      broadcast: (hex) => provider.sendRawTransaction(hex), on: show,
    });
    breach = res.some((x) => x.accepted);
    const refused = res.filter((x) => !x.accepted && !x.skipped).length;
    console.log(`\n${breach ? 'BREACH: a rule-breaking transaction was accepted. Please report.' : `The network refused ${refused} of ${res.length} rule-breaking transaction(s); the money stayed on the leash.`}`);
  }
  const { state } = await leash.getUtxos();
  if (state) console.log(`Leash now: ${sats(state.satoshis)}, window ${AgentLeash.stateOf(state).spent}/${rules.limit} sats spent.`);
  if (NET === 'chipnet') console.log(`Journal appended to scripts/agent-chipnet-log.jsonl`);
} finally {
  server.close();
}
process.exit(breach ? 2 : 0);
