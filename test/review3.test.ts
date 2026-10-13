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
