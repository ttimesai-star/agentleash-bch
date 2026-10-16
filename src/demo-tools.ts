// The three paid demo tools, shared by the web page (web/src/tools.ts) and the command-line agent
// (scripts/agent.ts). Browser-safe: no node: imports. The tools are deliberately small; what matters for the
// demo is that each call is paid over HTTP 402 from the leash and leaves a txid.
import type { NetworkProvider } from 'cashscript';
import type { PaidRoute } from './x402.js';

export interface DemoTool { name: string; path: string; title: string; price: bigint; description: string }

export const DEMO_TOOLS: DemoTool[] = [
  { name: 'chain_tip', path: '/chain-tip', title: 'Chain tip', price: 1_000n, description: 'Latest block height, straight from an Electrum server.' },
  { name: 'bch_price', path: '/bch-price', title: 'BCH price', price: 1_500n, description: 'BCH/USD from a public price API.' },
  { name: 'fortune', path: '/fortune', title: 'Agent fortune', price: 600n, description: 'A one-line fortune for a hard-working agent.' },
];

export const FORTUNES = [
  'A budget you cannot break is a budget you never have to watch.',
  'The network says no so that you do not have to.',
  'Small payments, often, with receipts: that is how agents earn trust.',
  'Your owner sleeps well tonight.',
  'Every satoshi you spend leaves an OP_RETURN behind.',
];

export interface DemoRouteOptions {
  provider: NetworkProvider;
  /** Shown in the chain-tip answer, e.g. "chipnet". */
  networkName: string;
  /** BCH/USD source; default: CoinGecko simple price (6 s timeout). Return null when unknown. */
  price?: () => Promise<number | null>;
  /** Source label for a configured price, e.g. "mock (fixed)". */
  priceLabel?: string;
  /** Index into FORTUNES; default random. */
  pick?: (n: number) => number;
}

export async function coingeckoPrice(): Promise<number | null> {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd', { signal: AbortSignal.timeout(6000) });
  const j = await r.json() as { 'bitcoin-cash'?: { usd?: number } };
  return j?.['bitcoin-cash']?.usd ?? null;
}

const json = (o: unknown) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });

export function demoRoutes(o: DemoRouteOptions): PaidRoute[] {
  const [tip, price, fortune] = DEMO_TOOLS;
  return [
    {
      method: 'GET', path: tip.path, price: tip.price, description: tip.description,
      handler: async () => json({ network: o.networkName, height: await o.provider.getBlockHeight(), at: new Date().toISOString() }),
    },
    {
      method: 'GET', path: price.path, price: price.price, description: price.description,
      handler: async () => {
        try {
          return json({ bch_usd: await (o.price ?? coingeckoPrice)(), source: o.price ? (o.priceLabel ?? 'configured') : 'coingecko' });
        } catch {
          return json({ bch_usd: null, note: 'price API unreachable; the payment still settled' });
        }
      },
    },
    {
      method: 'GET', path: fortune.path, price: fortune.price, description: fortune.description,
      handler: () => json({ fortune: FORTUNES[(o.pick ?? ((n) => Math.floor(Math.random() * n)))(FORTUNES.length) % FORTUNES.length] }),
    },
  ];
}
