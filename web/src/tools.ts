// Paid demo tools behind a real x402-style 402 paywall (`leash` scheme). For a static site the tool server
// runs inside this page: LeashPaywall checks the agent's payment and broadcasts it to the real network; the
// agent side is the SDK's leashFetch. Everything between them is the same HTTP message shape as the Node
// server in src/http.ts (402 + PAYMENT-REQUIRED, PAYMENT-SIGNATURE, 200 + PAYMENT-RESPONSE).
import type { ElectrumNetworkProvider } from 'cashscript';
import { LeashPaywall, decodeHeader, leashFetch, type AgentLeash, type PaymentRequired, type SettlementResponse } from '../../src/browser.js';
import type { NetConfig } from './config.js';
import { ageOf } from './chain.js';

export const ORIGIN = 'https://tools.agentleash.demo';

export interface Tool { path: string; title: string; price: bigint; description: string }
export const TOOLS: Tool[] = [
  { path: '/chain-tip', title: 'Chain tip', price: 1_000n, description: 'Latest block height and header time, straight from an Electrum server.' },
  { path: '/bch-price', title: 'BCH price', price: 1_500n, description: 'BCH/USD from a public price API.' },
  { path: '/fortune', title: 'Agent fortune', price: 600n, description: 'A one-line fortune for a hard-working agent.' },
];

const FORTUNES = [
  'A budget you cannot break is a budget you never have to watch.',
  'The network says no so that you do not have to.',
  'Small payments, often, with receipts: that is how agents earn trust.',
  'Your owner sleeps well tonight.',
  'Every satoshi you spend leaves an OP_RETURN behind.',
];

export function makePaywall(net: NetConfig, provider: ElectrumNetworkProvider, payTo: string): LeashPaywall {
  return new LeashPaywall({
    network: net.x402,
    payTo,
    origin: ORIGIN,
    provider,
    routes: [
      {
        method: 'GET', path: '/chain-tip', price: TOOLS[0].price, description: TOOLS[0].description,
        handler: async () => {
          const h = await provider.getBlockHeight();
          return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ network: net.name, height: h, at: new Date().toISOString() }) };
        },
      },
      {
        method: 'GET', path: '/bch-price', price: TOOLS[1].price, description: TOOLS[1].description,
        handler: async () => {
          try {
            const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd', { signal: AbortSignal.timeout(6000) });
            const j = await r.json();
            return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bch_usd: j?.['bitcoin-cash']?.usd ?? null, source: 'coingecko' }) };
          } catch {
            return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bch_usd: null, note: 'price API unreachable; the payment still settled' }) };
          }
        },
      },
      {
        method: 'GET', path: '/fortune', price: TOOLS[2].price, description: TOOLS[2].description,
        handler: () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fortune: FORTUNES[Math.floor(Math.random() * FORTUNES.length)] }) }),
      },
    ],
  });
}

export type FlowEvent =
  | { step: 'request'; text: string }
  | { step: 'challenge'; text: string; nonce: string; price: string }
  | { step: 'sign'; text: string }
  | { step: 'paid'; text: string; status: number; txid?: string; body?: string }
  | { step: 'refused'; text: string };

/** The agent calls a paid tool. Every hop is reported to `on` so the page can show the 402 dance. */
export async function callTool(args: {
  tool: Tool; leash: AgentLeash; agentPrivateKey: Uint8Array; net: NetConfig; paywall: LeashPaywall; maxPrice: bigint; on: (e: FlowEvent) => void;
}): Promise<void> {
  const { tool, leash, net, paywall, on } = args;
  const provider = leash.provider as ElectrumNetworkProvider;
  let hop = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    hop++;
    const headers: Record<string, string | undefined> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    if (headers['payment-signature']) on({ step: 'sign', text: `agent → GET ${tool.path} with PAYMENT-SIGNATURE (signed AgentLeash pay transaction)` });
    else on({ step: 'request', text: `agent → GET ${tool.path}` });
    const out = await paywall.handle({ method: init?.method ?? 'GET', path: new URL(url).pathname, headers });
    if (out.status === 402 && out.headers?.['PAYMENT-REQUIRED']) {
      const pr = decodeHeader<PaymentRequired>(out.headers['PAYMENT-REQUIRED']);
      const a = pr.accepts[0];
      on({ step: 'challenge', text: `tool ← 402 Payment Required${pr.error ? ` (${pr.error})` : ''}: ${a.amount} sats to ${a.payTo.slice(0, 22)}…, scheme "${a.scheme}"`, nonce: a.extra.nonce, price: a.amount });
    } else if (out.headers?.['PAYMENT-RESPONSE']) {
      const s = decodeHeader<SettlementResponse>(out.headers['PAYMENT-RESPONSE']);
      on({ step: 'paid', text: `tool ← ${out.status} ${s.success ? 'paid, content served' : s.errorReason ?? ''}`, status: out.status, txid: s.transaction, body: out.body });
    }
    return new Response(out.body ?? '', { status: out.status, headers: out.headers });
  }) as typeof fetch;
  try {
    const r = await leashFetch(`${ORIGIN}${tool.path}`, { method: 'GET' }, {
      leash, agentPrivateKey: args.agentPrivateKey, network: net.x402, maxPrice: args.maxPrice, fetchImpl,
      stateUtxo: async () => { const { state } = await leash.getUtxos(); if (!state) throw new Error('the leash is empty or closed'); return state; },
      elapsedAdd: (u) => ageOf(provider, u),
    });
    if (hop === 1 && r.response.status !== 200) on({ step: 'refused', text: `unexpected ${r.response.status}` });
  } catch (e: any) {
    on({ step: 'refused', text: String(e?.message ?? e) });
  }
}
