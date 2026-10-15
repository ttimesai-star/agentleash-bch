// Leash descriptors kept in localStorage. A descriptor is everything needed to rebuild the contract
// (its parameters are the address) plus, for leashes created in this browser, the demo agent's key.
import { binToHex, generatePrivateKey, hexToBin } from '@bitauth/libauth';
import { AgentLeash, pkhOfPrivateKey, type LeashParams } from '../../src/browser.js';
import type { NetName } from './config.js';
import type { NetworkProvider } from 'cashscript';

export interface LeashDescriptor {
  id: string;
  net: NetName;
  label: string;
  stateCategory: string;
  agentPkh: string;
  ownerLock: string;
  allow: string[];
  limit: string;
  period: string;
  maxFee: string;
  /** Agent key (hex). Present for leashes created here and for the public demo leash. */
  agentPriv?: string;
  /** true: the public demo leash; its agent key is published on purpose. */
  publicDemo?: boolean;
  genesisTxid?: string;
  createdAt: string;
}

const KEY = 'agentleash.leashes.v1';
const AGENT_KEY = 'agentleash.pendingAgent.v1';

export function loadAll(): LeashDescriptor[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
export function saveOne(d: LeashDescriptor): void {
  const all = loadAll().filter((x) => x.id !== d.id);
  all.unshift(d);
  localStorage.setItem(KEY, JSON.stringify(all.slice(0, 20)));
}
export function forget(id: string): void {
  localStorage.setItem(KEY, JSON.stringify(loadAll().filter((x) => x.id !== id)));
}

/** The agent key is created before genesis (its hash is a contract parameter) and kept until it is used. */
export function pendingAgentKey(): Uint8Array {
  const h = localStorage.getItem(AGENT_KEY);
  if (h && /^[0-9a-f]{64}$/.test(h)) return hexToBin(h);
  const k = generatePrivateKey();
  localStorage.setItem(AGENT_KEY, binToHex(k));
  return k;
}
export function consumePendingAgentKey(): void { localStorage.removeItem(AGENT_KEY); }

export function paramsOf(d: LeashDescriptor): LeashParams {
  return {
    stateCategory: d.stateCategory,
    agentPkh: hexToBin(d.agentPkh),
    ownerLock: hexToBin(d.ownerLock),
    allow: d.allow.map(hexToBin),
    limit: BigInt(d.limit),
    period: BigInt(d.period),
    maxFee: BigInt(d.maxFee),
  };
}

export function leashOf(d: LeashDescriptor, provider: NetworkProvider): AgentLeash {
  const leash = new AgentLeash(paramsOf(d), provider);
  if (d.agentPriv && binToHex(pkhOfPrivateKey(hexToBin(d.agentPriv))) !== d.agentPkh) throw new Error('stored agent key does not match the leash');
  return leash;
}

export function descriptorOf(args: { net: NetName; label: string; params: LeashParams; agentPriv?: Uint8Array; genesisTxid?: string }): LeashDescriptor {
  const p = args.params;
  return {
    id: `${args.net}:${p.stateCategory}`,
    net: args.net,
    label: args.label,
    stateCategory: p.stateCategory,
    agentPkh: binToHex(p.agentPkh),
    ownerLock: binToHex(p.ownerLock),
    allow: p.allow.map(binToHex),
    limit: p.limit.toString(),
    period: p.period.toString(),
    maxFee: p.maxFee.toString(),
    agentPriv: args.agentPriv ? binToHex(args.agentPriv) : undefined,
    genesisTxid: args.genesisTxid,
    createdAt: new Date().toISOString(),
  };
}

/** Share link: public parameters only (never the agent key unless it is the public demo). */
export function shareHash(d: LeashDescriptor): string {
  const { agentPriv, ...pub } = d;
  const payload = d.publicDemo ? d : pub;
  return '#leash=' + btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromShareHash(hash: string): LeashDescriptor | undefined {
  const m = hash.match(/^#leash=([A-Za-z0-9_-]+)$/);
  if (!m) return undefined;
  try {
    const d = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))) as LeashDescriptor;
    if (!d.stateCategory || !d.agentPkh || !d.ownerLock || !Array.isArray(d.allow)) return undefined;
    return d;
  } catch { return undefined; }
}
