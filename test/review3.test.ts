// Jules review 4474447409157392796 (2026-10-13): 402 paywall hardening.
// Each test reproduces the finding before the fix.
import { describe, expect, it } from 'vitest';
import {
  LeashPaywall, computeRequestHash, decodeHeader, encodeHeader,
  type PaymentPayload, type PaymentRequired, type PlainRequest,
} from '../src/index.js';
import { setup } from './helpers.js';

const ORIGIN = 'http://agentleash.test';
const challengeOf = (r: { headers?: Record<string, string> }) => decodeHeader<PaymentRequired>(r.headers!['PAYMENT-REQUIRED']);
const get = (path: string, headers: Record<string, string> = {}): PlainRequest => ({ method: 'GET', path, headers });

function mk(over: Partial<ConstructorParameters<typeof LeashPaywall>[0]> = {}) {
  const ctx = setup();
  ctx.addState(100_000n);
  let served = 0;
  const paywall = new LeashPaywall({
    network: 'bch:bchtest', payTo: ctx.server.address, origin: ORIGIN, provider: ctx.provider,
    routes: [{ method: 'GET', path: '/weather', price: 1_000n, handler: () => { served++; return { status: 200, body: 'ok' }; } }],
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

describe('Jules 2026-10-13: route price at or above dust', () => {
  it('refuses a route priced below 546 sats at construction (such a challenge can never be paid)', () => {
    const ctx = setup();
    const cfg = (price: bigint) => ({
      network: 'bch:bchtest' as const, payTo: ctx.server.address, origin: ORIGIN, provider: ctx.provider,
      routes: [{ method: 'GET', path: '/cheap', price, handler: () => ({ status: 200 }) }],
    });
    // why: the agent cannot even build a 545-sat payment output
    ctx.addState(100_000n);
    return ctx.leash.getUtxos().then(({ state }) => {
      expect(() => ctx.leash.buildPay({
        stateUtxo: state!, agentPrivateKey: ctx.agent.priv, payTo: ctx.server.address, amount: 545n, requestHash: '00'.repeat(32), elapsedAdd: 0n,
      }).build()).toThrow();
      expect(() => new LeashPaywall(cfg(545n))).toThrow('route GET /cheap price 545 sats is below dust (546)');
    expect(() => new LeashPaywall(cfg(0n))).toThrow(/below dust/);
      expect(() => new LeashPaywall(cfg(546n))).not.toThrow();
    });
  });
});

describe('Jules 2026-10-13: PAYMENT-SIGNATURE header name is case-insensitive', () => {
  it('a framework that keeps "Payment-Signature" as sent still gets paid content', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    const r = await m.paywall.handle(get('/weather', { 'Payment-Signature': sig }));
    expect(r.status).toBe(200);
    expect(m.served()).toBe(1);
  });
});

describe('Jules 2026-10-13: nonce store is bounded', () => {
  it('unpaid requests cannot grow the nonce map past maxNonces', async () => {
    const m = mk({ maxNonces: 50 });
    for (let i = 0; i < 500; i++) await m.paywall.handle(get('/weather'));
    expect(m.paywall.nonces.size).toBeLessThanOrEqual(50);
  });

  it('default cap is 10 000 open challenges', async () => {
    const m = mk();
    for (let i = 0; i < 10_200; i++) await m.paywall.handle(get('/weather'));
    expect(m.paywall.nonces.size).toBe(10_000);
  });

  it('expired nonces are dropped; a fresh challenge still pays after a flood', async () => {
    let now = 1_000_000;
    const m = mk({ maxNonces: 20, nonceTtlMs: 1_000, now: () => now });
    for (let i = 0; i < 20; i++) await m.paywall.handle(get('/weather'));
    now += 2_000;
    const pr = challengeOf(await m.paywall.handle(get('/weather')));
    expect(m.paywall.nonces.size).toBe(1);
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': await m.pay(pr) }))).status).toBe(200);
  });

  it('a nonce whose broadcast is in flight is never evicted', async () => {
    const m = mk({ maxNonces: 3 });
    const pr = challengeOf(await m.paywall.handle(get('/weather')));
    const nonce = pr.accepts[0].extra.nonce;
    const sig = await m.pay(pr);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const send = m.ctx.provider.sendRawTransaction.bind(m.ctx.provider);
    m.ctx.provider.sendRawTransaction = async (hex: string) => { await gate; return send(hex); };
    const paid = m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    for (let i = 0; i < 10; i++) await m.paywall.handle(get('/weather'));
    expect(m.paywall.nonces.get(nonce)?.state).toBe('pending');
    release();
    expect((await paid).status).toBe(200);
    expect(m.paywall.nonces.get(nonce)?.state).toBe('used');
  });

  it('rejects maxNonces below 1', () => {
    expect(() => mk({ maxNonces: 0 })).toThrow('maxNonces must be a positive integer');
  });
});

describe('Jules 2026-10-13: minConfirmations (0-conf double-spend), two-phase', () => {
  // Jules' patch read `utxo.height`, which cashscript Utxo does not have: confirmations were always 0,
  // so with minConfirmations > 0 the payment was broadcast and the content was never served.
  const confMk = (min = 1) => {
    let conf = 0;
    const m = mk({ minConfirmations: min, confirmations: async () => conf });
    return { ...m, setConf: (n: number) => { conf = n; } };
  };
  const settlementOf = (r: { headers?: Record<string, string> }) => decodeHeader<{ success: boolean; transaction?: string; errorReason?: string }>(r.headers!['PAYMENT-RESPONSE']);

  it('minConfirmations > 0 requires a confirmations source', () => {
    expect(() => mk({ minConfirmations: 1 })).toThrow('minConfirmations > 0 needs a confirmations(txid) source');
    expect(() => mk({ minConfirmations: -1, confirmations: async () => 0 })).toThrow('minConfirmations must be a non-negative integer');
  });

  it('broadcasts, answers 202 without serving and without a new challenge; same payment serves once confirmed', async () => {
    const m = confMk(1);
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    const first = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(first.status).toBe(202);
    expect(first.headers!['PAYMENT-REQUIRED']).toBeUndefined(); // a generic x402 client must not pay again
    const s1 = settlementOf(first);
    expect(s1.success).toBe(false);
    expect(s1.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(s1.errorReason).toBe('awaiting 1 confirmation(s), have 0');
    expect(m.served()).toBe(0);
    // the payment really left the leash
    expect((await m.ctx.leash.getUtxos()).state!.txid).toBe(s1.transaction);

    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(202);
    m.setConf(1);
    const done = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(done.status).toBe(200);
    expect(settlementOf(done)).toMatchObject({ success: true, transaction: s1.transaction });
    expect(m.served()).toBe(1);
    const replay = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(replay.status).toBe(402);
    expect(challengeOf(replay).error).toBe('nonce already used');
    expect(m.served()).toBe(1);
  });

  it('a paid nonce outlives nonceTtlMs while it waits (blocks take minutes), and is never evicted', async () => {
    let now = 1_000_000;
    let conf = 0;
    const m = mk({ minConfirmations: 1, confirmations: async () => conf, nonceTtlMs: 120_000, maxNonces: 5, now: () => now });
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(202);
    now += 30 * 60_000; // 30 min, three blocks late
    for (let i = 0; i < 50; i++) await m.paywall.handle(get('/weather')); // flood
    conf = 1;
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(200);
  });

  it('a waiting nonce cannot be redeemed with a different transaction', async () => {
    const m = confMk(1);
    const pr = challengeOf(await m.paywall.handle(get('/weather')));
    const sig = await m.pay(pr);
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(202);
    const other = await m.pay(pr); // same nonce, new tx from the new state
    m.setConf(6);
    const r = await m.paywall.handle(get('/weather', { 'payment-signature': other }));
    expect(r.status).toBe(402);
    expect(challengeOf(r).error).toBe('nonce is awaiting confirmation of another transaction');
    expect(m.served()).toBe(0);
  });

  it('a failing confirmations source counts as 0, not as confirmed', async () => {
    const m = mk({ minConfirmations: 1, confirmations: async () => { throw new Error('electrum down'); } });
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(202);
    const again = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(again.status).toBe(202);
    expect(settlementOf(again).errorReason).toBe('awaiting 1 confirmation(s), have 0');
    expect(m.served()).toBe(0);
  });

  it('concurrent retries while waiting serve the content once', async () => {
    const m = confMk(1);
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    m.setConf(1);
    const rs = await Promise.all([1, 2, 3].map(() => m.paywall.handle(get('/weather', { 'payment-signature': sig }))));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.every((r) => r.status === 200 || r.status === 202)).toBe(true);
    expect(m.served()).toBe(1);
  });

  it('default minConfirmations 0 keeps 0-conf settlement (200 on first try)', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    expect((await m.paywall.handle(get('/weather', { 'payment-signature': sig }))).status).toBe(200);
  });

  it('treats duplicate sendRawTransaction (already in mempool) as successfully broadcast', async () => {
    const m = mk();
    const sig = await m.pay(challengeOf(await m.paywall.handle(get('/weather'))));
    // The payer broadcast it first, so the node holds this exact transaction.
    await m.ctx.provider.sendRawTransaction(decodeHeader<PaymentPayload>(sig).payload.transaction);
    m.ctx.provider.sendRawTransaction = async () => {
      throw new Error('txn-already-in-mempool: transaction already in mempool');
    };
    const res = await m.paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(res.status).toBe(200);
    expect(m.served()).toBe(1);
  });

  it('reverts nonce state if route handler throws so payment is not permanently lost', async () => {
    const ctx = setup();
    ctx.addState(100_000n);
    let attempts = 0;
    const paywall = new LeashPaywall({
      network: 'bch:bchtest', payTo: ctx.server.address, origin: ORIGIN, provider: ctx.provider,
      routes: [{
        method: 'GET', path: '/weather', price: 1_000n,
        handler: () => {
          attempts++;
          if (attempts === 1) throw new Error('database connection lost');
          return { status: 200, body: 'ok' };
        },
      }],
    });
    const pr = challengeOf(await paywall.handle(get('/weather')));
    const a = pr.accepts[0];
    const requestHash = computeRequestHash({ challengeNonce: a.extra.nonce, method: 'GET', url: pr.resource.url });
    const tx = ctx.leash.buildPay({
      stateUtxo: (await ctx.leash.getUtxos()).state!, agentPrivateKey: ctx.agent.priv, payTo: a.payTo, amount: BigInt(a.amount), requestHash, elapsedAdd: 0n,
    });
    const sig = encodeHeader({ x402Version: 2, accepted: a, payload: { transaction: tx.build() } } satisfies PaymentPayload);

    await expect(paywall.handle(get('/weather', { 'payment-signature': sig }))).rejects.toThrow('database connection lost');
    const retry = await paywall.handle(get('/weather', { 'payment-signature': sig }));
    expect(retry.status).toBe(200);
    expect(attempts).toBe(2);
  });
});

describe('electrumConfirmations', () => {
  it('reads confirmations from verbose blockchain.transaction.get; mempool (no field) is 0', async () => {
    const calls: unknown[][] = [];
    const conf = (await import('../src/index.js')).electrumConfirmations({
      performRequest: async (...a: (string | number | boolean)[]) => { calls.push(a); return a[1] === 'aa' ? { confirmations: 9 } : {}; },
    });
    expect(await conf('aa')).toBe(9); // shape seen on chipnet 2026-10-13 for 9549bc3c...
    expect(await conf('bb')).toBe(0);
    expect(calls[0]).toEqual(['blockchain.transaction.get', 'aa', true]);
  });
});
