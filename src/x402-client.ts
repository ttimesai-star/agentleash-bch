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
  /**
   * Server settles only after N confirmations (202 = paid, waiting): re-send the SAME payment every
   * intervalMs (default 30 s) until it is served or timeoutMs (default 30 min) passes. Never pays again.
   * Off: the 202 is returned with `paid.paymentSignature` so the caller can re-send it later.
   */
  awaitConfirmations?: { intervalMs?: number; timeoutMs?: number };
}

export interface LeashFetchResult {
  response: Response;
  /** paymentSignature: the PAYMENT-SIGNATURE header sent; re-send it (same request) while the server answers 202. */
  paid?: { amount: bigint; txid?: string; settlement?: SettlementResponse; paymentSignature: string };
}

function mergeHeaders(existing: RequestInit['headers'], add: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  if (existing) {
    if (typeof (existing as Headers).entries === 'function') {
      for (const [k, v] of (existing as Headers).entries()) result[k] = v;
    } else if (Array.isArray(existing)) {
      for (const [k, v] of existing as [string, string][]) result[k] = v;
    } else if (typeof existing === 'object') {
      for (const [k, v] of Object.entries(existing)) if (v !== undefined) result[k] = v;
    }
  }
  for (const [k, v] of Object.entries(add)) result[k] = v;
  return result;
}

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
  const paymentSignature = encodeHeader(payload);
  const paidInit = { ...init, headers: mergeHeaders(init.headers, { 'PAYMENT-SIGNATURE': paymentSignature }) };
  let response = await f(url, paidInit);
  if (response.status === 202 && o.awaitConfirmations) {
    const interval = o.awaitConfirmations.intervalMs ?? 30_000;
    const deadline = Date.now() + (o.awaitConfirmations.timeoutMs ?? 30 * 60_000);
    while (response.status === 202 && Date.now() < deadline) {
      // Abortable wait: a caller's abort ends the wait at once, not after the next interval.
      await new Promise<void>((resolve, reject) => {
        const sig = init.signal;
        if (sig?.aborted) return reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
        const t = setTimeout(() => { sig?.removeEventListener('abort', onAbort); resolve(); }, interval);
        const onAbort = () => { clearTimeout(t); reject(sig!.reason ?? new DOMException('Aborted', 'AbortError')); };
        sig?.addEventListener('abort', onAbort, { once: true });
      });
      try {
        response = await f(url, paidInit);
      } catch (e) {
        // The payment is already made: a dropped poll is retried on the next interval, never paid again.
        // A caller's abort still ends the wait.
        if (init.signal?.aborted || (e as { name?: string })?.name === 'AbortError') throw e;
      }
    }
  }
  const sr = response.headers.get('payment-response');
  const settlement = sr ? decodeHeader<SettlementResponse>(sr) : undefined;
  return { response, paid: { amount, txid: settlement?.transaction, settlement, paymentSignature } };
}
