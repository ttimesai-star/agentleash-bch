// 402 paywall + agent on CHIPNET with real transactions. CHIPNET ONLY (refuses non-bchtest keys).
//   npx tsx scripts/x402-chipnet.ts run        genesis (if needed) -> server -> agent pays 2 calls -> replay -> limit stop
//   npx tsx scripts/x402-chipnet.ts run-conf   minConfirmations: 1 -> 202 -> real block -> same payment -> 200 once -> replay refused
//   npx tsx scripts/x402-chipnet.ts status
//   npx tsx scripts/x402-chipnet.ts withdraw   owner takes everything back
// Keys: ~/.claude/secrets/bch_chipnet_wallets.json (alice=owner, bob=agent), bch_chipnet_agentleash_server.json (payee).
// Every step is appended to scripts/x402-chipnet-log.jsonl.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import type { AddressInfo } from 'node:net';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, type SpendableUtxo } from 'cashscript';
import {
  AgentLeash, LeashPaywall, buildGenesis, electrumConfirmations, computeRequestHash, decodeHeader, encodeHeader, leashFetch, p2pkhLock, servePaywall,
  type LeashParams, type PaymentPayload, type PaymentRequired, type SettlementResponse,
} from '../src/index.js';

const SECRETS = `${homedir()}/.claude/secrets`;
const W = JSON.parse(readFileSync(`${SECRETS}/bch_chipnet_wallets.json`, 'utf8'));
const [alice, bob] = W.wallets;
const payee = JSON.parse(readFileSync(`${SECRETS}/bch_chipnet_agentleash_server.json`, 'utf8'));
for (const w of [alice, bob, payee]) if (!w.address.startsWith('bchtest:')) throw new Error('refusing: not a testnet wallet');

const STATE_FILE = new URL('./x402-chipnet-state.json', import.meta.url);
const LOG_FILE = new URL('./x402-chipnet-log.jsonl', import.meta.url);
const provider = new ElectrumNetworkProvider('chipnet');
const RULES = { limit: 6_000n, period: 3n, maxFee: 2_000n };
const PRICE = 1_500n;
const params = (category: string): LeashParams => ({
  stateCategory: category, agentPkh: hexToBin(bob.pkhHex), ownerLock: p2pkhLock(hexToBin(alice.pkhHex)),
  allow: [p2pkhLock(hexToBin(payee.pkhHex))], ...RULES,
});
const log = (e: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...e }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scripthash = (lb: Uint8Array) => binToHex(sha256.hash(lb).reverse());
async function ageOf(u: SpendableUtxo): Promise<bigint> {
  const tip = await provider.getBlockHeight();
  const list = await provider.performRequest('blockchain.scripthash.listunspent', scripthash(hexToBin(u.lockingBytecode))) as any[];
  const row = list.find((x) => x.tx_hash === u.txid && x.tx_pos === u.vout);
  return !row || row.height <= 0 ? 0n : BigInt(tip + 1 - row.height);
}
const loadLeash = () => new AgentLeash(params(JSON.parse(readFileSync(STATE_FILE, 'utf8')).category), provider);
async function waitState(leash: AgentLeash, txid?: string): Promise<SpendableUtxo> {
  for (let i = 0; i < 40; i++) {
    const { state } = await leash.getUtxos();
    if (state && (!txid || state.txid === txid)) return state;
    await sleep(1500);
  }
  throw new Error(`state UTXO ${txid ?? ''} not visible after 60 s`);
}

const cmd = process.argv[2] ?? 'status';
const ownerSig = new SignatureTemplate(hexToBin(alice.privHex));

if (cmd === 'status') {
  console.log('height', await provider.getBlockHeight());
  if (existsSync(STATE_FILE)) {
    const leash = loadLeash();
    const { state } = await leash.getUtxos();
    console.log('leash', leash.tokenAddress, state ? { state: AgentLeash.stateOf(state), value: state.satoshis, age: await ageOf(state) } : 'no state UTXO');
  }
} else if (cmd === 'run') {
  if (!existsSync(STATE_FILE)) {
    const g = (await provider.getUtxos(alice.address)).find((u) => !u.token && u.vout === 0 && u.satoshis > 30_000n);
    if (!g) throw new Error('alice needs a vout-0 UTXO > 30000 sats (run chipnet.ts genesis self-send first)');
    const { leash, builder } = buildGenesis({
      provider, ownerUtxo: g, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: alice.address,
      params: (({ stateCategory, ...p }) => p)(params('00'.repeat(32))), fund: 20_000n,
    });
    const txid = await provider.sendRawTransaction(builder.build());
    log({ step: 'genesis', ok: true, txid, leash: leash.tokenAddress, category: g.txid, rules: RULES });
    writeFileSync(STATE_FILE, JSON.stringify({ category: g.txid, address: leash.tokenAddress, genesis: txid }, null, 2));
  }
  const leash = loadLeash();
  await waitState(leash);

  const paywall = new LeashPaywall({
    network: 'bch:bchtest', payTo: payee.address, origin: 'http://127.0.0.1', provider,
    routes: [{ method: 'GET', path: '/price', price: PRICE, description: 'BCH price (demo)', handler: () => ({ status: 200, body: '{"pair":"BCH/USD","note":"demo payload"}' }) }],
  });
  const server = await servePaywall(paywall, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const agentPriv = hexToBin(bob.privHex);

  // call 1, by hand so the payment header can be replayed afterwards
  const c1 = await fetch(`${base}/price`);
  const pr = decodeHeader<PaymentRequired>(c1.headers.get('payment-required')!);
  log({ step: 'call 1: 402 challenge', status: c1.status, accepts: pr.accepts });
  let st = await waitState(leash);
  const tb = leash.buildPay({
    stateUtxo: st, agentPrivateKey: agentPriv, payTo: pr.accepts[0].payTo, amount: PRICE, elapsedAdd: await ageOf(st),
    requestHash: computeRequestHash({ challengeNonce: pr.accepts[0].extra.nonce, method: 'GET', url: pr.resource.url }),
  });
  const sig = encodeHeader({ x402Version: 2, accepted: pr.accepts[0], payload: { transaction: tb.build() } } satisfies PaymentPayload);
  const r1 = await fetch(`${base}/price`, { headers: { 'PAYMENT-SIGNATURE': sig } });
  const s1 = decodeHeader<SettlementResponse>(r1.headers.get('payment-response')!);
  log({ step: 'call 1: paid', status: r1.status, body: await r1.text(), settlement: s1 });
  if (r1.status !== 200) process.exit(1);

  const rr = await fetch(`${base}/price`, { headers: { 'PAYMENT-SIGNATURE': sig } });
  log({ step: 'attack: replay call-1 payment header', status: rr.status, error: decodeHeader<PaymentRequired>(rr.headers.get('payment-required')!).error });

  // call 2 through the client helper, chained on the unconfirmed state output of call 1
  st = await waitState(leash, s1.transaction);
  const opts = {
    leash, agentPrivateKey: agentPriv, network: 'bch:bchtest' as const, maxPrice: 2_000n,
    stateUtxo: async () => (await leash.getUtxos()).state!, elapsedAdd: ageOf,
  };
  const r2 = await leashFetch(`${base}/price`, { method: 'GET' }, opts);
  log({ step: 'call 2: paid via leashFetch', status: r2.response.status, settlement: r2.paid?.settlement, state: AgentLeash.stateOf(await waitState(leash, r2.paid?.txid)) });

  // call 3 would exceed the 6000-sat window: the agent SDK refuses before signing
  try {
    await leashFetch(`${base}/price`, { method: 'GET' }, opts);
    log({ step: 'call 3', unexpected: 'paid' });
  } catch (e: any) {
    log({ step: 'call 3: refused before signing', error: String(e?.message ?? e) });
  }
  server.close();
} else if (cmd === 'run-conf') {
  // minConfirmations: 1 against a real chipnet block. pay -> 202 -> wait for a block -> same payment re-sent -> 200,
  // content served once, money moved once; then the same payment again -> "nonce already used".
  const leash = loadLeash();
  const balance = async (addr: string) => (await provider.getUtxos(addr)).filter((u) => !u.token).reduce((s, u) => s + u.satoshis, 0n);
  const st0 = await waitState(leash);
  const before = { height: await provider.getBlockHeight(), leashValue: st0.satoshis, leashState: AgentLeash.stateOf(st0), payee: await balance(payee.address) };
  log({ step: 'conf: before', ...before, stateTxid: st0.txid });

  const electrum = electrumConfirmations(provider);
  let checks = 0;
  const confirmations = async (txid: string) => {
    const n = await electrum(txid);
    log({ step: 'conf: server confirmations check', n: ++checks, txid, confirmations: n, tip: await provider.getBlockHeight() });
    return n;
  };
  let served = 0;
  const paywall = new LeashPaywall({
    network: 'bch:bchtest', payTo: payee.address, origin: 'http://127.0.0.1', provider, minConfirmations: 1, confirmations,
    routes: [{ method: 'GET', path: '/price', price: PRICE, description: 'BCH price (demo)', handler: () => { served++; return { status: 200, body: '{"pair":"BCH/USD","note":"demo payload"}' }; } }],
  });
  const server = await servePaywall(paywall, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Logs every request/response verbatim; a 202 stays a 202 so leashFetch re-sends the same payment.
  const sent: string[] = [];
  let t202: number | undefined;
  const loggingFetch: typeof fetch = async (input, init) => {
    const sig = (init?.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE'];
    if (sig) sent.push(sig);
    const res = await fetch(input, init);
    const body = await res.clone().text();
    const pr = res.headers.get('payment-response');
    if (res.status === 202 && t202 === undefined) t202 = Date.now();
    log({
      step: `conf: agent ${sig ? 'paid request' : 'request'} -> ${res.status}`, status: res.status, body,
      paymentSignatureSha256: sig ? binToHex(sha256.hash(new TextEncoder().encode(sig))) : undefined,
      settlement: pr ? decodeHeader<SettlementResponse>(pr) : undefined, tip: await provider.getBlockHeight(),
    });
    return res;
  };
  const t0 = Date.now();
  const r = await leashFetch(`${base}/price`, { method: 'GET' }, {
    leash, agentPrivateKey: hexToBin(bob.privHex), network: 'bch:bchtest', maxPrice: 2_000n,
    stateUtxo: async () => (await leash.getUtxos()).state!, elapsedAdd: ageOf, fetchImpl: loggingFetch,
    awaitConfirmations: { intervalMs: 30_000, timeoutMs: 40 * 60_000 },
  });
  const txid = r.paid?.txid;
  const minedAt = txid ? await provider.performRequest('blockchain.transaction.get_height', txid) as number : undefined;
  log({
    step: 'conf: leashFetch done', status: r.response.status, txid, minedAt, waitedSec: t202 ? Math.round((Date.now() - t202) / 1000) : undefined,
    totalSec: Math.round((Date.now() - t0) / 1000), served, paidRequests: sent.length, sameSignature: new Set(sent).size === 1,
  });
  if (r.response.status !== 200 || !txid) { server.close(); process.exit(1); }

  const st1 = await waitState(leash, txid);
  const after = { height: await provider.getBlockHeight(), leashValue: st1.satoshis, leashState: AgentLeash.stateOf(st1), payee: await balance(payee.address) };
  const leashDelta = before.leashValue - after.leashValue;
  const payeeDelta = after.payee - before.payee;
  // One debit: the state moved by exactly this txid (waitState above), the payee got PRICE once, and the leash lost
  // PRICE + fee, which the covenant also recorded as spent (window was reset: age > period).
  const fee = leashDelta - PRICE;
  const payeeFromTx = (await provider.getUtxos(payee.address)).filter((u) => u.txid === txid);
  log({
    step: 'conf: after', ...after, leashDelta, payeeDelta, fee, spentInState: after.leashState.spent,
    checks: {
      servedOnce: served === 1, payeeGotPriceOnce: payeeDelta === PRICE && payeeFromTx.length === 1 && payeeFromTx[0].satoshis === PRICE,
      leashDebitedOnce: fee > 0n && fee <= RULES.maxFee && after.leashState.spent === leashDelta, sameSignature: new Set(sent).size === 1,
    },
  });

  // negative: the served payment re-sent once more
  const again = await fetch(`${base}/price`, { headers: { 'PAYMENT-SIGNATURE': sent[0] } });
  const againHdr = again.headers.get('payment-required');
  const againErr = againHdr ? decodeHeader<PaymentRequired>(againHdr).error : `no PAYMENT-REQUIRED; body: ${await again.text()}`;
  const st2 = await waitState(leash);
  log({
    step: 'conf: attack: re-send served payment', status: again.status, error: againErr, served,
    leashUnchanged: st2.txid === st1.txid, payeeUnchanged: (await balance(payee.address)) === after.payee,
  });
  server.close();
} else if (cmd === 'withdraw') {
  const leash = loadLeash();
  const { state, stray } = await leash.getUtxos();
  const own = (await provider.getUtxos(alice.address)).filter((u) => !u.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
  const tb = leash.buildWithdraw({ contractUtxos: [state!, ...stray].filter(Boolean), ownerUtxo: own, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: alice.address });
  const txid = await provider.sendRawTransaction(tb.build());
  log({ step: 'owner withdraw', txid });
}
process.exit(0);
