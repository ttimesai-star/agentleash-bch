// Jules review round 2 (2026-10-14): "already known" broadcasts, handler failure after payment,
// a hard bound on in-flight nonces, polling through a dropped connection. Reviewed and partly
// rewritten: see the commit message.
import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { NetworkProviderTransactionAlreadySubmittedError } from 'cashscript';
import {
  LeashPaywall, computeRequestHash, computeTxid, decodeHeader, encodeHeader, leashFetch, servePaywall,
  type PaymentPayload, type PaymentRequired, type PlainRequest, type SettlementResponse,
} from '../src/index.js';
import { setup } from './helpers.js';

const ORIGIN = 'http://agentleash.test';
const challengeOf = (r: { headers?: Record<string, string> }) => decodeHeader<PaymentRequired>(r.headers!['PAYMENT-REQUIRED']);
const settlementOf = (r: { headers?: Record<string, string> }) => decodeHeader<SettlementResponse>(r.headers!['PAYMENT-RESPONSE']);
const get = (path: string, headers: Record<string, string> = {}): PlainRequest => ({ method: 'GET', path, headers });
const txOf = (sig: string) => decodeHeader<PaymentPayload>(sig).payload.transaction;

type Handler = () => { status: number; body?: string } | Promise<{ status: number; body?: string }>;

function mk(over: Partial<ConstructorParameters<typeof LeashPaywall>[0]> = {}, handler?: Handler) {
  const ctx = setup();
  ctx.addState(100_000n);
  let served = 0;
  const paywall = new LeashPaywall({
    network: 'bch:bchtest', payTo: ctx.server.address, origin: ORIGIN, provider: ctx.provider,
    routes: [{ method: 'GET', path: '/weather', price: 1_000n, handler: handler ?? (() => { served++; return { status: 200, body: 'ok' }; }) }],
    ...over,
  });
  const pay = async (pr: PaymentRequired) => {
    const a = pr.accepts[0];
    const requestHash = computeRequestHash({ challengeNonce: a.extra.nonce, method: 'GET', url: pr.resource.url });
    const tx = ctx.leash.buildPay({
      stateUtxo: (await ctx.leash.getUtxos()).state!, agentPrivateKey: ctx.agent.priv, payTo: a.payTo, amount: BigInt(a.amount), requestHash, elapsedAdd: 0n,
    });
    return encodeHeader({ x402Version: 2, accepted: a, payload: { transaction: tx.build() } } satisfies PaymentPayload);
  };
  return { ctx, paywall, pay, served: () => served };
}

describe('Jules 2026-10-14: computeTxid', () => {
  it('matches the txid the network returns (double SHA-256, byte-reversed)', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    const hex = txOf(sig);
    const txid = await m.ctx.provider.sendRawTransaction(hex);
    expect(computeTxid(hex)).toBe(txid);
    expect(computeTxid(hex.toUpperCase())).toBe(txid);
    // Display order, not internal byte order.
    expect(computeTxid(hex)).not.toBe(txid.match(/../g)!.reverse().join(''));
  });
});

describe('Jules 2026-10-14: "already known" broadcast', () => {
  it('cashscript AlreadySubmitted error and the node holds the tx: served once, txid of that tx', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    const txid = await m.ctx.provider.sendRawTransaction(txOf(sig)); // the payer broadcast it first
    m.ctx.provider.sendRawTransaction = async () => {
      throw new NetworkProviderTransactionAlreadySubmittedError('the transaction was rejected by network rules.\n\ntxn-already-in-mempool');
    };
    const r = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(r.status).toBe(200);
    expect(settlementOf(r)).toMatchObject({ success: true, transaction: txid });
    expect(m.served()).toBe(1);
    // The nonce is spent: the same payment is not served twice.
    const again = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(again.status).toBe(402);
    expect(m.served()).toBe(1);
  });

  it('"already in mempool" text but the node does not hold the tx: rejected, nothing served', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    m.ctx.provider.sendRawTransaction = async () => { throw new Error('txn-already-in-mempool'); };
    const r = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(r.status).toBe(402);
    expect(settlementOf(r).errorReason).toBe('broadcast rejected: txn-already-in-mempool');
    expect(m.served()).toBe(0);
  });

  it('bad-txns-inputs-duplicate (an invalid tx) is a rejection, not "already known"', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    await m.ctx.provider.sendRawTransaction(txOf(sig)); // even with the tx retrievable by its txid
    m.ctx.provider.sendRawTransaction = async () => {
      throw new Error('the transaction was rejected by network rules.\n\nbad-txns-inputs-duplicate');
    };
    const r = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(r.status).toBe(402);
    expect(settlementOf(r).errorReason).toMatch(/^broadcast rejected: [\s\S]*bad-txns-inputs-duplicate/);
    expect(m.served()).toBe(0);
  });

  it('the node returns a different transaction for that txid: rejected', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    m.ctx.provider.sendRawTransaction = async () => { throw new Error('txn-already-known'); };
    m.ctx.provider.getRawTransaction = async () => '0200000000000000000000';
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(402);
    expect(m.served()).toBe(0);
  });

  it('a failing getRawTransaction counts as "not held"', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    m.ctx.provider.sendRawTransaction = async () => { throw new Error('transaction already in block chain'); };
    m.ctx.provider.getRawTransaction = async () => { throw new Error('electrum down'); };
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(402);
    expect(m.served()).toBe(0);
  });
});

describe('Jules 2026-10-14: handler fails after the payment', () => {
  it('0-conf: re-sending the same payment serves once without a second broadcast; a replay meanwhile is refused', async () => {
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const m = mk({}, async () => {
      attempts++;
      if (attempts === 1) throw new Error('db down');
      await gate;
      return { status: 200, body: 'ok' };
    });
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    await expect(m.paywall.handle(get('/weather', { 'payment-signature': sig }))).rejects.toThrow('db down');
    let broadcasts = 0;
    const send = m.ctx.provider.sendRawTransaction.bind(m.ctx.provider);
    m.ctx.provider.sendRawTransaction = async (h: string) => { broadcasts++; return send(h); };
    const retry = m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    const replay = await m.paywall.handle(get('/weather', { 'payment-signature': sig })); // while the retry's handler runs
    expect(replay.status).toBe(402);
    expect(challengeOf(replay).error).toBe('nonce already used');
    release();
    expect((await retry).status).toBe(200);
    expect(attempts).toBe(2);
    expect(broadcasts).toBe(0);
  });

  it('the reserved nonce outlives nonceTtlMs and a flood after a handler failure', async () => {
    let now = 1_000_000;
    let fail = true;
    const m = mk({ nonceTtlMs: 120_000, maxNonces: 3, now: () => now }, () => {
      if (fail) throw new Error('db down');
      return { status: 200, body: 'ok' };
    });
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    await expect(m.paywall.handle(get('/weather', { 'payment-signature': sig }))).rejects.toThrow('db down');
    now += 10 * 60_000;
    for (let i = 0; i < 20; i++) await m.paywall.handle(get('/weather'));
    fail = false;
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(200);
  });

  it('minConfirmations: a handler failure keeps the nonce settling; the next retry serves', async () => {
    let fail = true;
    let conf = 0;
    const m = mk({ minConfirmations: 1, confirmations: async () => conf }, () => {
      if (fail) throw new Error('db down');
      return { status: 200, body: 'ok' };
    });
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(202);
    conf = 1;
    await expect(m.paywall.handle(get('/weather', { 'payment-signature': sig }))).rejects.toThrow('db down');
    fail = false;
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(200);
  });
});

describe('Jules 2026-10-14: hard bound on in-flight nonces', () => {
  it('every slot paid and waiting: a new challenge gets 429, the store does not grow', async () => {
    const m = mk({ minConfirmations: 1, confirmations: async () => 0, maxNonces: 1 });
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(202);
    expect((await m.paywall.handle(get('/weather'))).status).toBe(429);
    expect(m.paywall.nonces.size).toBe(1);
    // The waiting payment itself still resumes.
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(202);
  });

  it('open nonces alone never trigger 429 (the oldest is evicted instead)', async () => {
    const m = mk({ maxNonces: 2 });
    for (let i = 0; i < 10; i++) expect((await m.paywall.handle(get('/weather'))).status).toBe(402);
    expect(m.paywall.nonces.size).toBeLessThanOrEqual(2);
  });
});

describe('Jules 2026-10-14: leashFetch polling', () => {
  const start = async () => {
    const ctx = setup();
    ctx.addState(100_000n);
    let checks = 0;
    const paywall = new LeashPaywall({
      network: 'bch:bchtest', payTo: ctx.server.address, origin: 'http://agentleash.test', provider: ctx.provider,
      minConfirmations: 1, confirmations: async () => (++checks >= 3 ? 1 : 0),
      routes: [{ method: 'GET', path: '/weather', price: 1_000n, handler: () => ({ status: 200, body: 'ok' }) }],
    });
    const s = await servePaywall(paywall, 0);
    return { ctx, s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
  };
  const opts = (ctx: ReturnType<typeof setup>, fetchImpl: typeof fetch, timeoutMs = 5_000) => ({
    leash: ctx.leash, agentPrivateKey: ctx.agent.priv, network: 'bch:bchtest' as const, maxPrice: 5_000n,
    stateUtxo: async () => (await ctx.leash.getUtxos()).state!, elapsedAdd: async () => 0n,
    fetchImpl, awaitConfirmations: { intervalMs: 1, timeoutMs },
  });

  it('a dropped connection during polling is retried; the payment is made once', async () => {
    const { ctx, s, base } = await start();
    try {
      let calls = 0;
      const flaky: typeof fetch = async (u, i) => {
        if (++calls === 3) throw new TypeError('fetch failed');
        return fetch(u, i);
      };
      const before = (await ctx.leash.getUtxos()).state!.satoshis;
      const r = await leashFetch(`${base}/weather`, { method: 'GET' }, opts(ctx, flaky));
      expect(r.response.status).toBe(200);
      expect(calls).toBeGreaterThan(3);
      expect(before - (await ctx.leash.getUtxos()).state!.satoshis).toBeLessThan(2_000n);
    } finally { s.close(); }
  });

  it('an abort by the caller ends the wait instead of polling until timeoutMs', async () => {
    const { ctx, s, base } = await start();
    try {
      const ac = new AbortController();
      let calls = 0;
      const aborting: typeof fetch = async (u, i) => {
        if (++calls === 3) {
          ac.abort();
          throw new DOMException('This operation was aborted', 'AbortError');
        }
        return fetch(u, i);
      };
      const t0 = Date.now();
      await expect(leashFetch(`${base}/weather`, { method: 'GET', signal: ac.signal }, opts(ctx, aborting, 3_000))).rejects.toThrow(/abort/i);
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally { s.close(); }
  });
});
