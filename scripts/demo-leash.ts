// The PUBLIC demo leash for the web page (CHIPNET ONLY). Its agent key is published in web/src/demo.json on
// purpose: anyone can act as the agent, and the covenant still only lets coins go to the allow-listed demo
// tool payee, at most `limit` per window. The owner key stays private (alice in the chipnet secrets).
//
//   npx tsx scripts/demo-leash.ts create        genesis with a fresh agent key, writes web/src/demo.json
//   npx tsx scripts/demo-leash.ts status
//   npx tsx scripts/demo-leash.ts topup <sats>  owner adds coins (state unchanged)
// Every broadcast goes to scripts/demo-leash-log.jsonl (txid or verbatim node error).
import { appendFileSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { binToHex, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type SpendableUtxo } from 'cashscript';
import { AgentLeash, buildGenesis, lockingBytecodeOf, p2pkhLock, pkhOfPrivateKey, type LeashParams } from '../src/index.js';

const SECRETS = `${homedir()}/.claude/secrets`;
const W = JSON.parse(readFileSync(`${SECRETS}/bch_chipnet_wallets.json`, 'utf8'));
const alice = W.wallets[0];
const server = JSON.parse(readFileSync(`${SECRETS}/bch_chipnet_agentleash_server.json`, 'utf8'));
for (const w of [alice, server]) if (!String(w?.address).startsWith('bchtest:')) throw new Error('refusing: not a testnet wallet');

const DEMO_FILE = new URL('../web/src/demo.json', import.meta.url);
const LOG_FILE = new URL('./demo-leash-log.jsonl', import.meta.url);
const provider = new ElectrumNetworkProvider('chipnet');
const RULES = { limit: 12_000n, period: 6n, maxFee: 2_000n };
const FUND = 300_000n;
const ownerSig = new SignatureTemplate(hexToBin(alice.privHex));

const log = (e: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...e }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
};
async function send(label: string, tb: TransactionBuilder, extra: Record<string, unknown> = {}) {
  const hex = tb.build();
  try { const txid = await provider.sendRawTransaction(hex); log({ label, ok: true, txid, ...extra }); return txid; }
  catch (e: any) { log({ label, ok: false, nodeError: String(e?.message ?? e), ...extra }); return undefined; }
}
const readDemo = () => JSON.parse(readFileSync(DEMO_FILE, 'utf8'));
const leashFromDemo = () => {
  const d = readDemo().chipnet;
  if (!d) throw new Error('no chipnet demo leash yet: run create');
  const params: LeashParams = { stateCategory: d.stateCategory, agentPkh: hexToBin(d.agentPkh), ownerLock: hexToBin(d.ownerLock), allow: d.allow.map(hexToBin), limit: BigInt(d.limit), period: BigInt(d.period), maxFee: BigInt(d.maxFee) };
  return new AgentLeash(params, provider);
};

const cmd = process.argv[2] ?? 'status';
if (cmd === 'create') {
  const existing = readDemo();
  if (existing.chipnet) throw new Error('a chipnet demo leash already exists in web/src/demo.json');
  const utxos = (await provider.getUtxos(alice.address)).filter((u) => !u.token);
  let g: SpendableUtxo | undefined = utxos.find((u) => u.vout === 0 && u.satoshis > FUND + 5_000n);
  if (!g) {
    const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
    const tb = new TransactionBuilder({ provider }).addInputs(utxos, ownerSig.unlockP2PKH()).addOutput({ to: alice.address, amount: total - 600n });
    const id = await send('self-send (vout 0 for genesis)', tb);
    if (!id) process.exit(1);
    g = { txid: id, vout: 0, satoshis: total - 600n, lockingBytecode: binToHex(lockingBytecodeOf(alice.address)) };
  }
  const agentPriv = generatePrivateKey();
  const base = { agentPkh: pkhOfPrivateKey(agentPriv), ownerLock: p2pkhLock(hexToBin(alice.pkhHex)), allow: [p2pkhLock(hexToBin(server.pkhHex))], ...RULES };
  const { leash, builder } = buildGenesis({ provider, ownerUtxo: g, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: alice.address, params: base, fund: FUND });
  const txid = await send('demo genesis', builder, { category: g.txid, leash: leash.tokenAddress, rules: RULES, fund: FUND });
  if (!txid) process.exit(1);
  const p = leash.params;
  existing.chipnet = {
    id: `chipnet:${p.stateCategory}`, net: 'chipnet', label: 'Public demo agent (chipnet)', publicDemo: true,
    stateCategory: p.stateCategory, agentPkh: binToHex(p.agentPkh), ownerLock: binToHex(p.ownerLock), allow: p.allow.map(binToHex),
    limit: p.limit.toString(), period: p.period.toString(), maxFee: p.maxFee.toString(),
    agentPriv: binToHex(agentPriv), genesisTxid: txid, createdAt: new Date().toISOString(),
  };
  writeFileSync(DEMO_FILE, JSON.stringify(existing, null, 2) + '\n');
  console.log('demo leash', leash.tokenAddress);
} else if (cmd === 'status') {
  const leash = leashFromDemo();
  const { state, stray } = await leash.getUtxos();
  console.log('height', await provider.getBlockHeight(), 'leash', leash.tokenAddress);
  console.log('state', state ? AgentLeash.stateOf(state) : 'none', 'value', state?.satoshis, 'stray', stray.length);
  console.log('owner', alice.address, (await provider.getUtxos(alice.address)).reduce((s, u) => s + u.satoshis, 0n), 'sats');
} else if (cmd === 'topup') {
  const amount = BigInt(process.argv[3] ?? '100000');
  const leash = leashFromDemo();
  const { state } = await leash.getUtxos();
  if (!state) throw new Error('no state UTXO');
  const own = (await provider.getUtxos(alice.address)).filter((u) => !u.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
  const tb = leash.buildTopUp({ stateUtxo: state, ownerUtxo: own, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: alice.address, amount });
  await send(`demo topup ${amount}`, tb);
}
process.exit(0);
