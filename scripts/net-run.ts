// One capped end-to-end run of AgentLeash on a real network: genesis -> agent pays the payee once (with a
// receipt) -> one attack the network must refuse -> owner withdraws everything. Same code for chipnet
// (rehearsal) and mainnet (the BLAZE "sends BCH mainnet transactions" requirement).
//
//   npx tsx scripts/net-run.ts chipnet status|run [--broadcast]
//   npx tsx scripts/net-run.ts mainnet status|run [--broadcast]
//
// Without --broadcast nothing is sent: the script builds the genesis and prints what it would do.
// Mainnet additionally requires AGENTLEASH_MAINNET_OK=yes in the environment (set only after the owner of
// the funds approved the run) and refuses anything above the hard caps below.
// Keys: chipnet = the project's chipnet secrets (alice owner, server payee); mainnet =
// ~/.claude/secrets/bch_mainnet_agentleash.json { "owner": { "privHex", "pkhHex", "address" }, "payee": { "address" } }.
// The agent key is generated per run and kept in local/net-run-<net>.json (gitignored). Never printed.
// Every broadcast goes to scripts/<net>-run-log.jsonl (txid or verbatim node error).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { binToHex, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type SpendableUtxo } from 'cashscript';
import {
  AgentLeash, buildAttack, buildGenesis, computeRequestHash, lockingBytecodeOf, localReason, p2pkhLock, pkhOfPrivateKey,
} from '../src/index.js';

const net = process.argv[2];
const cmd = process.argv[3] ?? 'status';
const BROADCAST = process.argv.includes('--broadcast');
if (net !== 'chipnet' && net !== 'mainnet') throw new Error('usage: net-run.ts chipnet|mainnet status|run [--broadcast]');

// Hard caps (sats). Mainnet: about 1 USD in the leash at most; fees are ~1 sat/byte.
const CAPS = net === 'mainnet'
  ? { fund: 20_000n, limit: 6_000n, maxFee: 1_500n, pay: 1_000n, ownerSpendTotal: 30_000n }
  : { fund: 30_000n, limit: 6_000n, maxFee: 2_000n, pay: 1_000n, ownerSpendTotal: 100_000n };
const RULES = { limit: CAPS.limit, period: 3n, maxFee: CAPS.maxFee };
const prefix = net === 'mainnet' ? 'bitcoincash:' : 'bchtest:';

const SECRETS = `${homedir()}/.claude/secrets`;
let owner: { privHex: string; pkhHex: string; address: string }, payeeAddress: string;
if (net === 'chipnet') {
  owner = JSON.parse(readFileSync(`${SECRETS}/bch_chipnet_wallets.json`, 'utf8')).wallets[0];
  payeeAddress = JSON.parse(readFileSync(`${SECRETS}/bch_chipnet_agentleash_server.json`, 'utf8')).address;
} else {
  const f = `${SECRETS}/bch_mainnet_agentleash.json`;
  if (!existsSync(f)) throw new Error(`missing ${f} (owner key + payee address); see the header of this script`);
  const m = JSON.parse(readFileSync(f, 'utf8'));
  owner = m.owner; payeeAddress = m.payee.address;
  if (BROADCAST && process.env.AGENTLEASH_MAINNET_OK !== 'yes') throw new Error('mainnet broadcast needs AGENTLEASH_MAINNET_OK=yes (owner approval)');
}
for (const a of [owner.address, payeeAddress]) if (!String(a).startsWith(prefix)) throw new Error(`refusing: ${a} is not a ${net} address`);
if (binToHex(pkhOfPrivateKey(hexToBin(owner.privHex))) !== owner.pkhHex) throw new Error('owner key does not match pkhHex');

const provider = new ElectrumNetworkProvider(net);
const ownerSig = new SignatureTemplate(hexToBin(owner.privHex));
const STATE = new URL(`../local/net-run-${net}.json`, import.meta.url);
const LOG = new URL(`./${net}-run-log.jsonl`, import.meta.url);
const log = (e: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), net, ...e }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  if (BROADCAST) appendFileSync(LOG, line + '\n');
  console.log(line);
};
let ownerSpent = 0n;
async function send(label: string, tb: TransactionBuilder, extra: Record<string, unknown> = {}): Promise<string | undefined> {
  const hex = tb.build();
  if (!BROADCAST) { log({ label, dryRun: true, bytes: hex.length / 2, localCheck: localReason(tb) || 'ok', ...extra }); return undefined; }
  try { const txid = await provider.sendRawTransaction(hex); log({ label, ok: true, txid, bytes: hex.length / 2, ...extra }); return txid; }
  catch (e: any) { log({ label, ok: false, nodeError: String(e?.originalError ?? e?.message ?? e).split('\n').filter((l) => !/^[0-9a-f]{120,}$/i.test(l)).join(' '), ...extra }); return undefined; }
}

if (cmd === 'status') {
  const u = await provider.getUtxos(owner.address);
  console.log(net, 'height', await provider.getBlockHeight());
  console.log('owner', owner.address, u.reduce((s, x) => s + x.satoshis, 0n), 'sats in', u.length, 'utxo');
  console.log('payee', payeeAddress, (await provider.getUtxos(payeeAddress)).reduce((s, x) => s + x.satoshis, 0n), 'sats');
  console.log('caps', CAPS, 'broadcast', BROADCAST);
  process.exit(0);
}
if (cmd !== 'run') throw new Error('unknown command');

mkdirSync(new URL('../local/', import.meta.url), { recursive: true });
const run = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
if (run.closed === false && BROADCAST) throw new Error(`an earlier ${net} run is still open (leash ${run.leash}); withdraw it first`);
const agentPriv = generatePrivateKey();

// 1. genesis input: a coin with vout 0 (CashTokens rule)
const coins = (await provider.getUtxos(owner.address)).filter((u) => !u.token);
let g: SpendableUtxo | undefined = coins.find((u) => u.vout === 0 && u.satoshis >= CAPS.fund + 2_000n);
if (!g) {
  const pick: SpendableUtxo[] = [];
  let total = 0n;
  for (const c of [...coins].sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))) { pick.push(c); total += c.satoshis; if (total >= CAPS.fund + 4_000n) break; }
  if (total < CAPS.fund + 4_000n) throw new Error(`owner has ${total} sats, needs ${CAPS.fund + 4_000n}`);
  const fee = 150n * BigInt(pick.length) + 100n;
  const tb = new TransactionBuilder({ provider }).addInputs(pick, ownerSig.unlockP2PKH()).addOutput({ to: owner.address, amount: total - fee });
  ownerSpent += fee;
  const id = await send('self-send (vout 0 for genesis)', tb);
  if (!BROADCAST) { console.log('dry run: stops before genesis (needs the self-send txid)'); process.exit(0); }
  if (!id) process.exit(1);
  g = { txid: id, vout: 0, satoshis: total - fee, lockingBytecode: binToHex(lockingBytecodeOf(owner.address)) };
}
const gen: SpendableUtxo = g;
const params = { agentPkh: pkhOfPrivateKey(agentPriv), ownerLock: p2pkhLock(hexToBin(owner.pkhHex)), allow: [lockingBytecodeOf(payeeAddress)], ...RULES };
const { leash, builder } = buildGenesis({ provider, ownerUtxo: gen, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: owner.address, params, fund: CAPS.fund });
if (CAPS.fund + ownerSpent > CAPS.ownerSpendTotal) throw new Error('cap: owner spend above the run cap');
const genTxid = await send('genesis', builder, { leash: leash.tokenAddress, category: gen.txid, rules: RULES, fund: CAPS.fund });
if (!BROADCAST) { console.log('dry run done: genesis built and checked locally, nothing sent'); process.exit(0); }
if (!genTxid) process.exit(1);
writeFileSync(STATE, JSON.stringify({ leash: leash.tokenAddress, category: gen.txid, genesis: genTxid, closed: false, agentPkh: binToHex(params.agentPkh) }, null, 2));

// 2. agent pays the payee once, receipt bound to a request
const live = new AgentLeash({ ...params, stateCategory: gen.txid }, provider);
const state = async () => { for (let i = 0; i < 20; i++) { const { state } = await live.getUtxos(); if (state) return state; await new Promise((r) => setTimeout(r, 3000)); } throw new Error('state coin not visible'); };
const s1 = await state();
const requestHash = computeRequestHash({ challengeNonce: binToHex(crypto.getRandomValues(new Uint8Array(16))), method: 'GET', url: 'https://tools.agentleash.demo/chain-tip' });
await send(`agent pays ${CAPS.pay}`, live.buildPay({ stateUtxo: s1, agentPrivateKey: agentPriv, payTo: payeeAddress, amount: CAPS.pay, requestHash, elapsedAdd: 0n }), { requestHash });

// 3. compromised agent: pay itself. Must be refused by the network.
const s2 = await state();
const atk = buildAttack('recipient', { leash: live, stateUtxo: s2, agentPrivateKey: agentPriv, realAge: 0n });
await send('attack: pay a non-allow-listed address (must be rejected)', atk.builder, { localReason: localReason(atk.builder) });

// 4. owner takes everything back without the agent key
const s3 = await state();
const own = (await provider.getUtxos(owner.address)).filter((u) => !u.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
if (!own) throw new Error('owner has no coin for the owner path');
const wd = await send('owner withdraws everything', live.buildWithdraw({ contractUtxos: [s3], ownerUtxo: own, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: owner.address }));
if (wd) writeFileSync(STATE, JSON.stringify({ leash: leash.tokenAddress, category: gen.txid, genesis: genTxid, withdraw: wd, closed: true }, null, 2));
process.exit(0);
