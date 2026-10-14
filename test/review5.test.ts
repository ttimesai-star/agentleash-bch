// Jules review 3258987019283182858 (2026-10-14, round 3): retry during an in-flight broadcast,
// and a caller's abort during the confirmation wait. Each test fails on 177831c.
import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  LeashPaywall, computeRequestHash, decodeHeader, encodeHeader, leashFetch, servePaywall,
  type PaymentPayload, type PaymentRequired, type PlainRequest,
} from '../src/index.js';
import { setup } from './helpers.js';

const ORIGIN = 'http://agentleash.test';
const get = (path: string, headers: Record<string, string> = {}): PlainRequest => ({ method: 'GET', path, headers });

describe('Jules 2026-10-14: identical retry while the broadcast is in flight', () => {
  it('gets 202 (awaiting), not "nonce already used", and the content is served once', async () => {
    const ctx = setup();
    ctx.addState(100_000n);
    let served = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const send = ctx.provider.sendRawTransaction.bind(ctx.provider);
    const provider = Object.assign(Object.create(Object.getPrototypeOf(ctx.provider)), ctx.provider, {
      sendRawTransaction: async (hex: string) => { await gate; return send(hex); },
    });
    const paywall = new LeashPaywall({
      network: 'bch:bchtest', payTo: ctx.server.address, origin: ORIGIN, provider,
      routes: [{ method: 'GET', path: '/weather', price: 1_000n, handler: () => { served++; return { status: 200, body: 'ok' }; } }],
    });
    const pr = decodeHeader<PaymentRequired>((await paywall.handle(get('/weather'))).headers!['PAYMENT-REQUIRED']);
    const a = pr.accepts[0];
    const requestHash = computeRequestHash({ challengeNonce: a.extra.nonce, method: 'GET', url: pr.resource.url });
    const tx = ctx.leash.buildPay({
      stateUtxo: (await ctx.leash.getUtxos()).state!, agentPrivateKey: ctx.agent.priv, payTo: a.payTo, amount: BigInt(a.amount), requestHash, elapsedAdd: 0n,
    });
    const sig = encodeHeader({ x402Version: 2, accepted: a, payload: { transaction: tx.build() } } satisfies PaymentPayload);

    const first = paywall.handle(get('/weather', { 'PAYMENT-SIGNATURE': sig }));
    await new Promise((r) => setTimeout(r, 10)); // first call is now waiting inside sendRawTransaction
    const retry = await paywall.handle(get('/weather', { 'PAYMENT-SIGNATURE': sig }));
    expect(retry.status).toBe(202);
    release();
    expect((await first).status).toBe(200);
    expect(served).toBe(1);
  });
});

describe('Jules 2026-10-14: caller abort during the confirmation wait', () => {
  it('ends the wait at once instead of after the polling interval', async () => {
    const ctx = setup();
    ctx.addState(100_000n);
    const paywall = new LeashPaywall({
      network: 'bch:bchtest', payTo: ctx.server.address, origin: ORIGIN, provider: ctx.provider,
      minConfirmations: 1, confirmations: async () => 0,
      routes: [{ method: 'GET', path: '/weather', price: 1_000n, handler: () => ({ status: 200, body: 'ok' }) }],
    });
    const server = await servePaywall(paywall, 0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const ac = new AbortController();
      const t0 = Date.now();
      setTimeout(() => ac.abort(), 300);
      await expect(leashFetch(`${base}/weather`, { method: 'GET', signal: ac.signal }, {
        leash: ctx.leash, agentPrivateKey: ctx.agent.priv, network: 'bch:bchtest', maxPrice: 5_000n,
        stateUtxo: async () => (await ctx.leash.getUtxos()).state!, elapsedAdd: async () => 0n,
        awaitConfirmations: { intervalMs: 20_000, timeoutMs: 60_000 },
      })).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  });
});
