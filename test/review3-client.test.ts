// Jules review 4474447409157392796 (2026-10-13), client side of minConfirmations: over node:http the
// agent pays once, gets 202 while the server waits for confirmations, re-sends the same payment, never pays twice.
import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { LeashPaywall, leashFetch, servePaywall } from '../src/index.js';
import { setup } from './helpers.js';

describe('Jules 2026-10-13: leashFetch with a minConfirmations server', () => {
  const run = async (awaitConfirmations?: { intervalMs?: number; timeoutMs?: number }, confirmAfterChecks = 2) => {
    const ctx = setup();
    ctx.addState(100_000n);
    let checks = 0;
    let served = 0;
    const paywall = new LeashPaywall({
      network: 'bch:bchtest', payTo: ctx.server.address, origin: 'http://agentleash.test', provider: ctx.provider,
      minConfirmations: 1, confirmations: async () => (++checks >= confirmAfterChecks ? 1 : 0),
      routes: [{ method: 'GET', path: '/weather', price: 1_000n, handler: () => { served++; return { status: 200, body: '{"t":12}' }; } }],
    });
    const server = await servePaywall(paywall, 0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const before = (await ctx.leash.getUtxos()).state!.satoshis;
      const r = await leashFetch(`${base}/weather`, { method: 'GET' }, {
        leash: ctx.leash, agentPrivateKey: ctx.agent.priv, network: 'bch:bchtest', maxPrice: 5_000n,
        stateUtxo: async () => (await ctx.leash.getUtxos()).state!, elapsedAdd: async () => 0n, awaitConfirmations,
      });
      const after = (await ctx.leash.getUtxos()).state!.satoshis;
      return { r, served, spent: before - after, base, ctx };
    } finally {
      server.close();
    }
  };

  it('re-sends the same payment until confirmed: one payment, content served once', async () => {
    const { r, served, spent } = await run({ intervalMs: 1, timeoutMs: 5_000 }, 2);
    expect(r.response.status).toBe(200);
    expect(await r.response.text()).toBe('{"t":12}');
    expect(r.paid?.settlement?.success).toBe(true);
    expect(served).toBe(1);
    expect(spent).toBeGreaterThanOrEqual(1_000n);
    expect(spent).toBeLessThan(2_000n); // paid once (price + fee), not twice
  });

  it('without awaitConfirmations returns the 202 and the header to re-send', async () => {
    const { r, served } = await run(undefined, 2);
    expect(r.response.status).toBe(202);
    expect(r.paid?.settlement).toMatchObject({ success: false, errorReason: 'awaiting 1 confirmation(s), have 0' });
    expect(r.paid?.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof r.paid?.paymentSignature).toBe('string');
    expect(served).toBe(0);
  });

  it('gives up at timeoutMs with the 202, still without paying again', async () => {
    const { r, served, spent } = await run({ intervalMs: 5, timeoutMs: 40 }, 1_000_000);
    expect(r.response.status).toBe(202);
    expect(served).toBe(0);
    expect(spent).toBeLessThan(2_000n);
  });
});
