// Network flag. chipnet is the default and the only network the public demo opens without a build flag.
// Mainnet is wired the same way but stays locked unless the site is built with VITE_ALLOW_MAINNET=1
// (prototype, unaudited: see README "Mainnet run"). Every mainnet operation is capped below.
import type { BchNetwork } from '../../src/browser.js';

export type NetName = 'chipnet' | 'mainnet';

export interface NetConfig {
  name: NetName;
  label: string;
  /** CashAddr prefix. */
  prefix: 'bchtest' | 'bitcoincash';
  /** x402 network id. */
  x402: BchNetwork;
  /** CashScript network name and Electrum (WebSocket) host. */
  cashscript: 'chipnet' | 'mainnet';
  electrum: string;
  explorerTx: (txid: string) => string;
  explorerAddr: (addr: string) => string;
  /** Where test coins come from (chipnet only). */
  faucet?: string;
  /** Hard caps for this network (sats). */
  maxFund: bigint;
  maxLimit: bigint;
  /** A browser-generated owner key is allowed only where coins have no value. */
  burnerOwner: boolean;
  /** Payee of the demo tools (must be on the leash allow-list for the agent to pay them). */
  demoToolPayee?: string;
  /** Rough USD per BCH for display only (not a price feed). */
  usdPerBch: number;
}

export const ALLOW_MAINNET = import.meta.env.VITE_ALLOW_MAINNET === '1';

export const NETWORKS: Record<NetName, NetConfig> = {
  chipnet: {
    name: 'chipnet',
    label: 'Chipnet (test coins)',
    prefix: 'bchtest',
    x402: 'bch:bchtest',
    cashscript: 'chipnet',
    electrum: 'chipnet.bch.ninja',
    explorerTx: (t) => `https://chipnet.chaingraph.cash/tx/${t}`,
    explorerAddr: (a) => `https://chipnet.chaingraph.cash/address/${a}`,
    faucet: 'https://tbch.googol.cash/',
    maxFund: 10_000_000n,
    maxLimit: 10_000_000n,
    burnerOwner: true,
    // AgentLeash chipnet demo tool server (same payee as the 13.10 chipnet 402 run in README)
    demoToolPayee: import.meta.env.VITE_CHIPNET_TOOL_PAYEE || 'bchtest:qqczgu296nfwrqum84mu3n8staqk6shjqczv9jmjsx',
    usdPerBch: 0,
  },
  mainnet: {
    name: 'mainnet',
    label: 'Mainnet (real BCH)',
    prefix: 'bitcoincash',
    x402: 'bch:bitcoincash',
    cashscript: 'mainnet',
    electrum: 'bch.imaginary.cash',
    explorerTx: (t) => `https://blockchair.com/bitcoin-cash/transaction/${t}`,
    explorerAddr: (a) => `https://blockchair.com/bitcoin-cash/address/${a}`,
    // about 1 USD at ~500 USD/BCH: prototype, unaudited
    maxFund: 200_000n,
    maxLimit: 50_000n,
    burnerOwner: false,
    demoToolPayee: import.meta.env.VITE_MAINNET_TOOL_PAYEE || undefined,
    usdPerBch: 500,
  },
};

export function initialNetwork(): NetName {
  const q = new URLSearchParams(location.search).get('net');
  if (q === 'mainnet' && ALLOW_MAINNET) return 'mainnet';
  return 'chipnet';
}
