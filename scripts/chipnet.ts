// AgentLeash on CHIPNET. Usage:
//   npx tsx scripts/chipnet.ts status
//   npx tsx scripts/chipnet.ts genesis          owner (alice) creates the leash (self-send first if no vout-0 UTXO)
//   npx tsx scripts/chipnet.ts pay <sats>       agent (bob) pays the allow-listed server
//   npx tsx scripts/chipnet.ts attack <kind>    broadcast a transaction the contract must reject:
//                                               overspend | recipient | fakereset | fee | clock
//   npx tsx scripts/chipnet.ts withdraw         owner takes everything back (NFT burned)
// Keys: ~/.claude/secrets/bch_chipnet_wallets.json (alice=owner, bob=agent) and
//       ~/.claude/secrets/bch_chipnet_agentleash_server.json (payee). Never printed. CHIPNET ONLY.
// Every broadcast is appended to scripts/chipnet-log.jsonl (txid or verbatim node error).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { binToHex, decodeTransaction, hexToBin, sha256 } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder, type SpendableUtxo } from 'cashscript';
import { AgentLeash, buildGenesis, encodeState, lockingBytecodeOf, nextState, p2pkhLock, receiptLockingBytecode, computeRequestHash, type LeashParams } from '../src/index.js';

const SECRETS = `${homedir()}/.claude/secrets`;
const W = JSON.parse(readFileSync(`${SECRETS}/bch_chipnet_wallets.json`, 'utf8'));
const [alice, bob] = W.wallets;
const server = JSON.parse(readFileSync(`${SECRETS}/bch_chipnet_agentleash_server.json`, 'utf8'));
for (const w of [...W.wallets, server]) {
  if (!w?.address || typeof w.address !== 'string' || !w.address.startsWith('bchtest:')) {
    throw new Error('refusing: not a testnet wallet');
  }
}

const STATE_FILE = new URL('./chipnet-state.json', import.meta.url);
const LOG_FILE = new URL('./chipnet-log.jsonl', import.meta.url);
const provider = new ElectrumNetworkProvider('chipnet');

const RULES = { limit: 6_000n, period: 3n, maxFee: 2_000n };
const params = (category: string): LeashParams => ({
  stateCategory: category,
  agentPkh: hexToBin(bob.pkhHex),
  ownerLock: p2pkhLock(hexToBin(alice.pkhHex)),
  allow: [p2pkhLock(hexToBin(server.pkhHex))],
  ...RULES,
});

const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
};
const loadLeash = () => {
  if (!existsSync(STATE_FILE)) throw new Error('no leash yet: run genesis');
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  return new AgentLeash(params(s.category), provider);
};
const scripthash = (lockingBytecode: Uint8Array) => binToHex(sha256.hash(lockingBytecode).reverse());

/** Real age (blocks) of a UTXO as BIP68 will see it in the next block; 0 if unconfirmed. */
async function ageOf(u: SpendableUtxo): Promise<bigint> {
  const tip = await provider.getBlockHeight();
  const list = await provider.performRequest('blockchain.scripthash.listunspent', scripthash(hexToBin(u.lockingBytecode))) as any[];
  const row = list.find((x) => x.tx_hash === u.txid && x.tx_pos === u.vout);
  if (!row || row.height <= 0) return 0n;
  return BigInt(tip + 1 - row.height);
}

async function broadcast(label: string, tb: TransactionBuilder, extra: Record<string, unknown> = {}) {
  const hex = tb.build();
  try {
    const txid = await provider.sendRawTransaction(hex);
    log({ label, ok: true, txid, bytes: hex.length / 2, ...extra });
    return txid;
  } catch (e: any) {
    log({ label, ok: false, nodeError: String(e?.message ?? e), bytes: hex.length / 2, ...extra });
    return undefined;
  }
}

const cmd = process.argv[2] ?? 'status';
const ownerSig = new SignatureTemplate(hexToBin(alice.privHex));

if (cmd === 'status') {
  console.log('height', await provider.getBlockHeight());
  for (const [n, a] of [['alice(owner)', alice.address], ['bob(agent)', bob.address], ['server', server.address]]) {
    const u = await provider.getUtxos(a);
    console.log(n, a, u.reduce((s, x) => s + x.satoshis, 0n), 'sats,', u.length, 'utxo');
  }
  if (existsSync(STATE_FILE)) {
    const leash = loadLeash();
    const { state, stray, invalid } = await leash.getUtxos();
    console.log('leash', leash.tokenAddress);
    if (state) console.log('state', AgentLeash.stateOf(state), 'value', state.satoshis, 'age', await ageOf(state), 'utxo', `${state.txid}:${state.vout}`);
    console.log('stray', stray.length, 'invalid', invalid.length);
  }
} else if (cmd === 'genesis') {
  if (existsSync(STATE_FILE)) throw new Error('leash already exists (chipnet-state.json)');
  let utxos = (await provider.getUtxos(alice.address)).filter((u) => !u.token);
  let g: SpendableUtxo | undefined = utxos.find((u) => u.vout === 0 && u.satoshis > 60_000n);
  if (!g) {
    // self-send so that we own an outpoint with index 0 (CashTokens genesis rule)
    const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
    const tb = new TransactionBuilder({ provider }).addInputs(utxos, ownerSig.unlockP2PKH()).addOutput({ to: alice.address, amount: total - 400n });
    const selfTxid = await broadcast('self-send (vout 0 for genesis)', tb);
    if (!selfTxid) process.exit(1);
    g = { txid: selfTxid, vout: 0, satoshis: total - 400n, lockingBytecode: binToHex(lockingBytecodeOf(alice.address)) };
  }
  const gen: SpendableUtxo = g;
  const { leash, builder } = buildGenesis({
    provider, ownerUtxo: gen, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: alice.address,
    params: (({ stateCategory, ...p }) => p)(params('00'.repeat(32))), fund: 40_000n,
  });
  const txid = await broadcast('genesis', builder, { category: gen.txid, leash: leash.tokenAddress, rules: RULES });
  if (txid) writeFileSync(STATE_FILE, JSON.stringify({ category: gen.txid, address: leash.tokenAddress, genesis: txid, rules: { limit: RULES.limit.toString(), period: RULES.period.toString(), maxFee: RULES.maxFee.toString() } }, null, 2));
} else if (cmd === 'pay') {
  const leash = loadLeash();
  const amount = BigInt(process.argv[3] ?? '1000');
  const { state } = await leash.getUtxos();
  if (!state) throw new Error('no state UTXO');
  const age = await ageOf(state);
  const elapsedAdd = age > 65535n ? 65535n : age;
  const requestHash = computeRequestHash({ challengeNonce: binToHex(crypto.getRandomValues(new Uint8Array(16))), method: 'GET', url: 'https://agentleash.local/api/price' });
  const before = AgentLeash.stateOf(state);
  const tb = leash.buildPay({ stateUtxo: state, agentPrivateKey: hexToBin(bob.privHex), payTo: server.address, amount, requestHash, elapsedAdd });
  const hex = tb.build();
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(tx);
  const outflow = state.satoshis - tx.outputs[0].valueSatoshis;
  await broadcast(`pay ${amount}`, tb, { elapsedAdd, before, fee: outflow - amount, after: nextState(before, elapsedAdd, outflow, RULES.period, RULES.limit), requestHash });
} else if (cmd === 'attack') {
  const kind = process.argv[3] ?? 'overspend';
  const leash = loadLeash();
  const { state } = await leash.getUtxos();
  if (!state) throw new Error('no state UTXO');
  const st = AgentLeash.stateOf(state);
  const agent = new SignatureTemplate(hexToBin(bob.privHex));
  const agentPub = hexToBin(bob.pubHex);
  // each attack breaks exactly one rule; everything else is what an honest pay would contain
  let amount = 546n, fee = 710n, payTo: Uint8Array = lockingBytecodeOf(server.address);
  let claim = 0n;
  if (kind === 'overspend') amount = RULES.limit - st.spent - fee + 1n;           // 1 sat over the limit
  if (kind === 'recipient') payTo = lockingBytecodeOf(bob.address);              // agent pays itself
  if (kind === 'fee') fee = RULES.maxFee + 1n;                                   // 1 sat over maxFee
  if (kind === 'clock') claim = RULES.period;                                    // claims age it does not have
  let newState = { elapsed: st.elapsed + claim, spent: st.spent + amount + fee };
  if (newState.elapsed >= RULES.period) newState = { elapsed: 0n, spent: amount + fee };
  if (kind === 'fakereset') newState = { elapsed: 0n, spent: amount + fee };      // reset without proven age
  if (amount < 546n) throw new Error('state too close to the limit for this attack');
  const tb = new TransactionBuilder({ provider })
    .addInput(state, leash.contract.unlock.pay(agentPub, agent, claim), { sequence: Number(claim) })
    .addOutput({ to: leash.tokenAddress, amount: state.satoshis - amount - fee, token: { category: state.token!.category, amount: 0n, nft: { capability: 'mutable', commitment: encodeState(newState) } } })
    .addOutput({ to: payTo, amount })
    .addOutput({ to: receiptLockingBytecode(sha256.hash(new Uint8Array([1, 2, 3]))), amount: 0n });
  let localReason = '';
  try { tb.debug(); } catch (e: any) { localReason = String(e.message).split('\n').find((l: string) => l.includes('require')) ?? String(e.message).split('\n')[0]; }
  await broadcast(`attack ${kind}`, tb, { stateBefore: st, realAge: await ageOf(state), claimedAge: claim, claimedState: newState, amount, fee, localReason });
} else if (cmd === 'withdraw') {
  const leash = loadLeash();
  const { state, stray } = await leash.getUtxos();
  const own = (await provider.getUtxos(alice.address)).filter((u) => !u.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
  const tb = leash.buildWithdraw({ contractUtxos: [state!, ...stray].filter(Boolean), ownerUtxo: own, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: alice.address });
  await broadcast('owner withdraw', tb, { took: [state, ...stray].filter(Boolean).reduce((s, u) => s + u!.satoshis, 0n) });
}
process.exit(0);
