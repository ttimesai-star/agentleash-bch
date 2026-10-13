// Agent side of the 402 flow: request -> 402 challenge -> build an AgentLeash payment bound to the
// request -> retry with PAYMENT-SIGNATURE. The agent never broadcasts; the server settles.
import { binToHex } from '@bitauth/libauth';
import type { SpendableUtxo } from 'cashscript';
import { AgentLeash, lockingBytecodeOf } from './leash.js';
import { computeRequestHash } from './receipt.js';
import {
  SCHEME_LEASH, X402_VERSION, decodeHeader, encodeHeader,
  type BchNetwork, type PaymentPayload, type PaymentRequired, type SettlementResponse,
} from './x402.js';

export interface LeashFetchOptions {
  leash: AgentLeash;
  agentPrivateKey: Uint8Array;
  network: BchNetwork;
  /** Refuse any single request priced above this (sats). Off-chain guard on top of the covenant limit. */
  maxPrice: bigint;
  /** Current state UTXO of the leash (e.g. from leash.getUtxos()). */
  stateUtxo: () => Promise<SpendableUtxo>;
  /** Proven age to claim for the state UTXO; 0 if unconfirmed. Must not exceed the real age. */
  elapsedAdd: (u: SpendableUtxo) => Promise<bigint>;
  fetchImpl?: typeof fetch;
}

export interface LeashFetchResult { response: Response; paid?: { amount: bigint; txid?: string; settlement?: SettlementResponse } }

export async function leashFetch(url: string, init: RequestInit & { body?: string }, o: LeashFetchOptions): Promise<LeashFetchResult> {
  const f = o.fetchImpl ?? fetch;
  const first = await f(url, init);
  if (first.status !== 402) return { response: first };
  const h = first.headers.get('payment-required');
  if (!h) throw new Error('402 without PAYMENT-REQUIRED header');
  const pr = decodeHeader<PaymentRequired>(h);
  if (pr.x402Version !== X402_VERSION) throw new Error(`unsupported x402Version ${pr.x402Version}`);
  const req = pr.accepts.find((a) => a.scheme === SCHEME_LEASH && a.network === o.network);
  if (!req) throw new Error(`server offers no ${SCHEME_LEASH} payment on ${o.network}`);
  const amount = BigInt(req.amount);
  if (amount > o.maxPrice) throw new Error(`price ${amount} sats exceeds agent maxPrice ${o.maxPrice}`);
  const payToHex = binToHex(lockingBytecodeOf(req.payTo));
  if (!o.leash.params.allow.some((a) => binToHex(a) === payToHex)) throw new Error(`payTo ${req.payTo} is not on this leash's allow-list`);

  const requestHash = computeRequestHash({ challengeNonce: req.extra.nonce, method: init.method ?? 'GET', url: pr.resource.url, body: init.body });
  const stateUtxo = await o.stateUtxo();
  const tx = o.leash.buildPay({
    stateUtxo, agentPrivateKey: o.agentPrivateKey, payTo: req.payTo, amount, requestHash, elapsedAdd: await o.elapsedAdd(stateUtxo),
  });
  const payload: PaymentPayload = { x402Version: X402_VERSION, accepted: req, payload: { transaction: tx.build() } };
  const second = await f(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'PAYMENT-SIGNATURE': encodeHeader(payload) } });
  const sr = second.headers.get('payment-response');
  const settlement = sr ? decodeHeader<SettlementResponse>(sr) : undefined;
  return { response: second, paid: { amount, txid: settlement?.transaction, settlement } };
}
