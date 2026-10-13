// 402 paywall (`leash` scheme) on MockNetworkProvider, which validates every broadcast against the
// covenant and updates the UTXO set, so the server's settlement really runs the contract.
import { afterAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  LeashPaywall, LimitExceededError, computeRequestHash, decodeHeader, encodeHeader, leashFetch, servePaywall,
  type PaymentPayload, type PaymentRequired, type PlainRequest, type SettlementResponse,
} from '../src/index.js';
import { H, rawPay, receiptOut, setup, stateOut } from './helpers.js';

const ORIGIN = 'http://agentleash.test';

function mk(over: { price?: bigint; now?: () => number } = {}) {
  const ctx = setup();
  ctx.addState(100_000n);
  const paywall = new LeashPaywall({
    network: 'bch:bchtest', payTo: ctx.server.address, origin: ORIGIN, provider: ctx.provider, now: over.now,
    routes: [
      { method: 'GET', path: '/weather', price: over.price ?? 1_000n, description: 'weather', handler: () => ({ status: 200, body: '{"t":12}' }) },
      { method: 'POST', path: '/summarize', price: 1_500n, handler: (r) => ({ status: 200, body: `len=${r.body?.length ?? 0}` }) },
    ],
  });
  const state = async () => (await ctx.leash.getUtxos()).state!;
  return { ctx, paywall, state };
}

const challengeOf = (r: { headers?: Record<string, string> }) => decodeHeader<PaymentRequired>(r.headers!['PAYMENT-REQUIRED']);

/** Agent builds a valid payment for a challenge, optionally tampering. */
async function payFor(m: ReturnType<typeof mk>, pr: PaymentRequired, o: { method?: string; body?: string; amount?: bigint; payTo?: string } = {}) {
  const a = pr.accepts[0];
  const requestHash = computeRequestHash({ challengeNonce: a.extra.nonce, method: o.method ?? 'GET', url: pr.resource.url, body: o.body });
  const tx = m.ctx.leash.buildPay({
    stateUtxo: await m.state(), agentPrivateKey: m.ctx.agent.priv, payTo: o.payTo ?? a.payTo, amount: o.amount ?? BigInt(a.amount), requestHash, elapsedAdd: 0n,
  });
  const p: PaymentPayload = { x402Version: 2, accepted: a, payload: { transaction: tx.build() } };
  return encodeHeader(p);
}

const req = (path: string, sig?: string, method = 'GET', body?: string): PlainRequest => ({
  method, path, headers: sig ? { 'payment-signature': sig } : {}, body: body === undefined ? undefined : new TextEncoder().encode(body),
});

describe('402 paywall, leash scheme', () => {
  it('unpaid request gets 402 with an x402 v2 challenge', async () => {
    const { paywall, ctx } = mk();
    const r = await paywall.handle(req('/weather'));
    expect(r.status).toBe(402);
    const pr = challengeOf(r);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe(`${ORIGIN}/weather`);
    expect(pr.accepts).toHaveLength(1);
    expect(pr.accepts[0]).toMatchObject({ scheme: 'leash', network: 'bch:bchtest', amount: '1000', asset: 'BCH', payTo: ctx.server.address });
    expect(pr.accepts[0].extra.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect((await paywall.handle(req('/nope'))).status).toBe(404);
  });

  it('valid payment settles on the (mock) chain and returns content + PAYMENT-RESPONSE', async () => {
    const m = mk();
    const pr = challengeOf(await m.paywall.handle(req('/weather')));
    const r = await m.paywall.handle(req('/weather', await payFor(m, pr)));
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"t":12}');
    const s = decodeHeader<SettlementResponse>(r.headers!['PAYMENT-RESPONSE']);
    expect(s).toMatchObject({ success: true, network: 'bch:bchtest' });
    expect(s.transaction).toMatch(/^[0-9a-f]{64}$/);
    // the covenant state moved: 1000 + fee spent
    const st = (await m.ctx.leash.getUtxos()).state!;
    expect(st.txid).toBe(s.transaction);
  });

  it('replaying the same payment header is refused (one-time nonce)', async () => {
    const m = mk();
    const pr = challengeOf(await m.paywall.handle(req('/weather')));
    const sig = await payFor(m, pr);
    expect((await m.paywall.handle(req('/weather', sig))).status).toBe(200);
    const again = await m.paywall.handle(req('/weather', sig));
    expect(again.status).toBe(402);
    expect(challengeOf(again).error).toBe('nonce already used');
  });

  it('receipt binds method, url and body: a payment for body A does not buy body B', async () => {
    const m = mk();
    const pr = challengeOf(await m.paywall.handle(req('/summarize', undefined, 'POST', 'A')));
    const sig = await payFor(m, pr, { method: 'POST', body: 'A' });
    const r = await m.paywall.handle(req('/summarize', sig, 'POST', 'B'));
    expect(r.status).toBe(402);
    expect(challengeOf(r).error).toBe('receipt does not bind this request (nonce/method/url/body)');
    // the honest request with body A still works with the same (unconsumed) nonce
    expect((await m.paywall.handle(req('/summarize', sig, 'POST', 'A'))).body).toBe('len=1');
  });

  it('nonce issued for one route cannot pay another', async () => {
    const m = mk();
    const pr = challengeOf(await m.paywall.handle(req('/weather')));
    const r = await m.paywall.handle(req('/summarize', await payFor(m, pr), 'POST'));
    expect(challengeOf(r).error).toBe('nonce issued for another resource');
  });

  it('underpayment and paying another allow-listed address are refused before broadcast', async () => {
    const m = mk();
    let pr = challengeOf(await m.paywall.handle(req('/weather')));
    let r = await m.paywall.handle(req('/weather', await payFor(m, pr, { amount: 999n })));
    expect(challengeOf(r).error).toBe('underpaid: 999 < 1000 sats');
    pr = challengeOf(await m.paywall.handle(req('/weather')));
    r = await m.paywall.handle(req('/weather', await payFor(m, pr, { payTo: m.ctx.server2.address })));
    expect(challengeOf(r).error).toBe('payment output does not pay payTo');
    // nothing was broadcast: state UTXO unchanged
    expect(AgentLeashState(await m.state())).toEqual({ elapsed: 0n, spent: 0n });
  });

  it('expired nonce is refused', async () => {
    let t = 1_000_000;
    const m = mk({ now: () => t });
    const pr = challengeOf(await m.paywall.handle(req('/weather')));
    const sig = await payFor(m, pr);
    t += 121_000;
    expect(challengeOf(await m.paywall.handle(req('/weather', sig))).error).toBe('nonce expired');
  });

  it('garbage headers are refused with a fresh challenge', async () => {
    const m = mk();
    expect(challengeOf(await m.paywall.handle(req('/weather', 'not-base64-json!!'))).error).toBe('malformed PAYMENT-SIGNATURE');
    const pr = challengeOf(await m.paywall.handle(req('/weather')));
    const bad = encodeHeader({ x402Version: 2, accepted: pr.accepts[0], payload: { transaction: 'zz' } });
    expect(challengeOf(await m.paywall.handle(req('/weather', bad))).error).toBe('payload.transaction must be hex');
    const v1 = encodeHeader({ x402Version: 1, accepted: pr.accepts[0], payload: { transaction: '00' } });
    expect(challengeOf(await m.paywall.handle(req('/weather', v1))).error).toBe('unsupported x402Version');
    const other = encodeHeader({ x402Version: 2, accepted: { ...pr.accepts[0], scheme: 'exact' }, payload: { transaction: '00' } });
    expect(challengeOf(await m.paywall.handle(req('/weather', other))).error).toBe('unsupported scheme');
  });

  it('a payment the covenant rejects is not settled; the nonce stays usable', async () => {
    const m = mk();
    const pr = challengeOf(await m.paywall.handle(req('/weather')));
    const a = pr.accepts[0];
    const st = await m.state();
    // well-formed for the server, but claims 5 blocks of age on a fresh UTXO -> contract must fail
    const rh = computeRequestHash({ challengeNonce: a.extra.nonce, method: 'GET', url: pr.resource.url });
    const tb = rawPay(m.ctx, {
      input: st, elapsedAdd: 5n, sequence: 0,
      outputs: [stateOut(m.ctx, st.satoshis - 1_000n - 800n, { elapsed: 5n, spent: 1_800n }), { to: m.ctx.server.address, amount: 1_000n }, receiptOut(rh)],
    });
    const sig = encodeHeader({ x402Version: 2, accepted: a, payload: { transaction: tb.build() } });
    const r = await m.paywall.handle(req('/weather', sig));
    expect(r.status).toBe(402);
    expect(challengeOf(r).error).toMatch(/^broadcast rejected:/);
    expect(decodeHeader<SettlementResponse>(r.headers!['PAYMENT-RESPONSE']).success).toBe(false);
    expect(m.paywall.nonces.get(a.extra.nonce)!.state).toBe('open');
    // honest payment for the same nonce then succeeds
    expect((await m.paywall.handle(req('/weather', await payFor(m, pr)))).status).toBe(200);
  });
});

import { AgentLeash } from '../src/index.js';
const AgentLeashState = (u: Parameters<typeof AgentLeash.stateOf>[0]) => AgentLeash.stateOf(u);

describe('agent client over real HTTP (node:http)', () => {
  let server: Server | undefined;
  afterAll(() => server?.close());

  it('pays three calls in a row, refuses an over-price call and stops at the covenant limit', async () => {
    const m = mk({ price: 2_000n });
    server = await servePaywall(m.paywall, 0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const opts = {
      leash: m.ctx.leash, agentPrivateKey: m.ctx.agent.priv, network: 'bch:bchtest' as const, maxPrice: 5_000n,
      stateUtxo: m.state, elapsedAdd: async () => 0n,
    };
    const txids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { response, paid } = await leashFetch(`${base}/weather`, { method: 'GET' }, opts);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"t":12}');
      txids.push(paid!.txid!);
    }
    expect(new Set(txids).size).toBe(3);
    // 3 x (2000 + ~705 fee) = ~8115 of 10000 spent; a 4th payment would exceed the limit -> refused before signing
    await expect(leashFetch(`${base}/weather`, { method: 'GET' }, opts)).rejects.toBeInstanceOf(LimitExceededError);
    await expect(leashFetch(`${base}/weather`, { method: 'GET' }, { ...opts, maxPrice: 1_999n })).rejects.toThrow(/exceeds agent maxPrice/);
    const free = await leashFetch(`${base}/nope`, { method: 'GET' }, opts);
    expect(free.response.status).toBe(404);
    // body-bound POST over HTTP
    const post = await leashFetch(`${base}/summarize`, { method: 'POST', body: 'hello' }, { ...opts, maxPrice: 5_000n }).catch((e) => e);
    expect(post).toBeInstanceOf(LimitExceededError); // still over the window limit
  });

  it('refuses a payTo that is not on the leash allow-list', async () => {
    const ctx = setup();
    ctx.addState(100_000n);
    const pw = new LeashPaywall({ network: 'bch:bchtest', payTo: ctx.attacker.address, origin: ORIGIN, provider: ctx.provider,
      routes: [{ method: 'GET', path: '/x', price: 600n, handler: () => ({ status: 200, body: 'x' }) }] });
    const s = await servePaywall(pw, 0);
    try {
      const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      await expect(leashFetch(`${base}/x`, { method: 'GET' }, {
        leash: ctx.leash, agentPrivateKey: ctx.agent.priv, network: 'bch:bchtest', maxPrice: 5_000n,
        stateUtxo: async () => (await ctx.leash.getUtxos()).state!, elapsedAdd: async () => 0n,
      })).rejects.toThrow(/not on this leash's allow-list/);
    } finally { s.close(); }
  });
});

void H;
