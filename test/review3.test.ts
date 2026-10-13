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
