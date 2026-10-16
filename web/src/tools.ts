// Paid demo tools behind a real x402-style 402 paywall (`leash` scheme). For a static site the tool server
// runs inside this page: LeashPaywall checks the agent's payment and broadcasts it to the real network; the
// agent side is the SDK's leashFetch. Everything between them is the same HTTP message shape as the Node
// server in src/http.ts (402 + PAYMENT-REQUIRED, PAYMENT-SIGNATURE, 200 + PAYMENT-RESPONSE).
// The tools themselves are shared with the command-line agent (src/demo-tools.ts).
import type { SpendableUtxo } from 'cashscript';
import {
  DEMO_GOAL, DEMO_TOOLS, LeashPaywall, ScriptedPlanner, decodeHeader, demoPlanner, demoRoutes, leashFetch, runAgent,
  type AgentEvent, type AgentLeash, type AgentRunResult, type DemoTool, type ElectrumLike, type PaymentRequired, type SettlementResponse,
} from '../../src/browser.js';
import type { NetConfig } from './config.js';
import { ageOf } from './chain.js';

export const ORIGIN = 'https://tools.agentleash.demo';

export type Tool = DemoTool;
export const TOOLS: Tool[] = DEMO_TOOLS;

export function makePaywall(net: NetConfig, provider: ElectrumLike, payTo: string): LeashPaywall {
  return new LeashPaywall({ network: net.x402, payTo, origin: ORIGIN, provider, routes: demoRoutes({ provider, networkName: net.name }) });
}

export type FlowEvent =
  | { step: 'request'; text: string }
  | { step: 'challenge'; text: string; nonce: string; price: string }
  | { step: 'sign'; text: string }
  | { step: 'paid'; text: string; status: number; txid?: string; body?: string }
  | { step: 'refused'; text: string };

/** In-page "HTTP": the agent's fetch goes straight to the paywall; every hop is reported to `on`. */
function pageFetch(paywall: LeashPaywall, on: (e: FlowEvent) => void, label: (path: string) => string): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const headers: Record<string, string | undefined> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const path = new URL(url).pathname;
    if (headers['payment-signature']) on({ step: 'sign', text: `agent → GET ${label(path)} with PAYMENT-SIGNATURE (signed AgentLeash pay transaction)` });
    else on({ step: 'request', text: `agent → GET ${label(path)}` });
    const out = await paywall.handle({ method: init?.method ?? 'GET', path, headers });
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
}

/** State coin of the leash; after a payment, wait until the server shows the new one (Electrum index lag). */
function stateReader(leash: AgentLeash) {
  return async (afterTxid?: string): Promise<SpendableUtxo> => {
    for (let i = 0; i < 30; i++) {
      const { state } = await leash.getUtxos();
      if (!state) throw new Error('the leash is empty or closed');
      if (!afterTxid || state.txid === afterTxid) return state;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('the new state coin is not visible yet: try again in a few seconds');
  };
}

/** The agent calls a paid tool. Every hop is reported to `on` so the page can show the 402 dance. */
export async function callTool(args: {
  tool: Tool; leash: AgentLeash; agentPrivateKey: Uint8Array; net: NetConfig; paywall: LeashPaywall; maxPrice: bigint; on: (e: FlowEvent) => void;
}): Promise<void> {
  const { tool, leash, net, paywall, on } = args;
  const provider = leash.provider as ElectrumLike;
  let hop = 0;
  const inner = pageFetch(paywall, on, () => tool.path);
  const fetchImpl = (async (url: string, init?: RequestInit) => { hop++; return inner(url, init); }) as typeof fetch;
  const state = stateReader(leash);
  try {
    const r = await leashFetch(`${ORIGIN}${tool.path}`, { method: 'GET' }, {
      leash, agentPrivateKey: args.agentPrivateKey, network: net.x402, maxPrice: args.maxPrice, fetchImpl,
      stateUtxo: () => state(), elapsedAdd: (u) => ageOf(provider, u),
    });
    if (hop === 1 && r.response.status !== 200) on({ step: 'refused', text: `unexpected ${r.response.status}` });
  } catch (e: any) {
    on({ step: 'refused', text: String(e?.message ?? e) });
  }
}

export const BRIEF_GOAL = 'Brief me on Bitcoin Cash right now: chain tip, price, and a fortune.';
const BRIEF_PLAN = [
  { tool: 'chain_tip', why: 'the goal asks for the current chain tip' },
  { tool: 'bch_price', why: 'the goal asks for the price' },
  { tool: 'fortune', why: 'the goal asks for a fortune' },
];

/**
 * Autopilot: the demo agent (src/agent.ts, scripted planner: no model key in a public page) works through
 * its goal on its own and pays for every tool call, until the leash window refuses. Same loop as
 * `npm run agent`; the LLM planner runs from the command line with your own key.
 */
export async function runAutopilot(args: {
  leash: AgentLeash; agentPrivateKey: Uint8Array; net: NetConfig; paywall: LeashPaywall; untilRefused: boolean; maxSteps?: number; on: (e: AgentEvent) => void;
}): Promise<AgentRunResult> {
  const provider = args.leash.provider as ElectrumLike;
  // The public demo leash is shared: the short run (3 calls, ~5 200 sats of the 12 000 window) leaves room
  // for the next visitor; "until refused" spends the window on purpose to show the refusal.
  const planner = args.untilRefused ? demoPlanner() : new ScriptedPlanner(BRIEF_PLAN);
  return runAgent({
    goal: args.untilRefused ? DEMO_GOAL : BRIEF_GOAL, tools: TOOLS, planner, baseUrl: ORIGIN, leash: args.leash, agentPrivateKey: args.agentPrivateKey,
    network: args.net.x402, maxPrice: 5_000n, fetchImpl: pageFetch(args.paywall, () => {}, (p) => p),
    stateUtxo: stateReader(args.leash), elapsedAdd: (u) => ageOf(provider, u), maxSteps: args.maxSteps ?? 8, on: args.on,
  });
}
