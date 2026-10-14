// HTTP 402 paywall for AgentLeash payments, in the x402 v2 message shape:
//   402 + header PAYMENT-REQUIRED  (base64 JSON PaymentRequired)
//   retry with header PAYMENT-SIGNATURE (base64 JSON PaymentPayload)
//   200 + header PAYMENT-RESPONSE  (base64 JSON SettlementResponse)
//
// Scheme `leash` (ours, not part of the x402 spec): the payload is a fully signed BCH transaction in the
// AgentLeash `pay` shape — out[1] pays `payTo`, out[2] is the receipt OP_RETURN "LSH1" <requestHash>,
// where requestHash = computeRequestHash(nonce, method, resource url, body). The server checks the
// payment and the binding, consumes the one-time nonce, then settles by broadcasting (mempool, 0-conf).
// With `minConfirmations` > 0 settlement is two-phase: broadcast, answer 202 (no new challenge), and serve
// when the client re-sends the same payment after the transaction has that many confirmations.
//
// Only `leash` is implemented. The standard `exact` scheme (@x402/bch) is NOT offered yet: advertising
// it before it works would be dishonest.
//
// Framework-free: `handle()` maps a plain request to a plain response, so it runs under node:http,
// tests, or any other server.
import { randomBytes } from 'node:crypto';
import { binToHex, decodeTransaction, hexToBin, sha256 } from '@bitauth/libauth';
import { NetworkProviderTransactionAlreadySubmittedError, type NetworkProvider } from 'cashscript';
import { computeRequestHash, parseReceipt } from './receipt.js';
import { DUST, lockingBytecodeOf } from './leash.js';

export const X402_VERSION = 2;
export const SCHEME_LEASH = 'leash';
export type BchNetwork = 'bch:bchtest' | 'bch:bitcoincash';

export interface PaidRoute {
  method: string;
  /** Exact path, e.g. "/weather". */
  path: string;
  /** Price in satoshis. */
  price: bigint;
  description?: string;
  /** Produces the paid content once payment is settled. */
  handler: (req: PlainRequest) => Promise<PlainResponse> | PlainResponse;
}

export interface PaywallConfig {
  network: BchNetwork;
  /** P2PKH CashAddr that receives payments (must be on the payer's allow-list). */
  payTo: string;
  /** Public origin used in resource URLs, e.g. "http://localhost:4020". */
  origin: string;
  routes: PaidRoute[];
  provider: NetworkProvider;
  /** One-time nonce lifetime. Default 120 s. */
  nonceTtlMs?: number;
  /**
   * Most nonces held in memory; when full the oldest are evicted (never one being broadcast or paid and
   * waiting). If every slot is in flight, new challenges get 429. Default 10 000.
   */
  maxNonces?: number;
  /**
   * Confirmations required before content is served. Default 0: serve on mempool acceptance (a payer
   * could race a double spend). Above 0 needs `confirmations`.
   */
  minConfirmations?: number;
  /** Confirmations of a txid (0 if unconfirmed or unknown). See `electrumConfirmations`. */
  confirmations?: (txid: string) => Promise<number>;
  /** How long a broadcast payment may wait for confirmations; its nonce stays reserved. Default 2 h. */
  confirmTimeoutMs?: number;
  now?: () => number;
}

export interface PlainRequest { method: string; path: string; headers: Record<string, string | undefined>; body?: Uint8Array }
export interface PlainResponse { status: number; headers?: Record<string, string>; body?: string }

export interface PaymentRequirements {
  scheme: string; network: BchNetwork; amount: string; asset: 'BCH'; payTo: string; maxTimeoutSeconds: number;
  extra: { nonce: string; receipt: 'LSH1'; requestHash: 'sha256(len|nonce|len|method|len16|url|sha256(body))' };
}
export interface PaymentRequired { x402Version: number; error?: string; resource: { url: string; description?: string }; accepts: PaymentRequirements[] }
export interface PaymentPayload { x402Version: number; accepted: PaymentRequirements; payload: { transaction: string } }
export interface SettlementResponse { success: boolean; transaction?: string; network: BchNetwork; errorReason?: string }

export const encodeHeader = (o: unknown): string =>
  Buffer.from(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), 'utf8').toString('base64');
export const decodeHeader = <T>(h: string): T => JSON.parse(Buffer.from(h, 'base64').toString('utf8')) as T;

interface NonceRecord {
  method: string; path: string; url: string; price: bigint; expires: number;
  /** settling: broadcast, waiting for minConfirmations. pending: a broadcast or confirmation check is in flight. */
  state: 'open' | 'pending' | 'settling' | 'used';
  /** Set once broadcast. */
  txid?: string; txHex?: string;
}

/** Confirmations source for `PaywallConfig.confirmations` over Electrum/Fulcrum (verbose transaction.get). */
export function electrumConfirmations(provider: { performRequest(name: string, ...p: (string | number | boolean)[]): Promise<unknown> }) {
  return async (txid: string): Promise<number> => {
    const r = await provider.performRequest('blockchain.transaction.get', txid, true) as { confirmations?: number } | undefined;
    return typeof r?.confirmations === 'number' ? r.confirmations : 0;
  };
}

/** Transaction id: double SHA-256 of the serialized transaction, byte-reversed (display order). */
export function computeTxid(txHex: string): string {
  return binToHex(sha256.hash(sha256.hash(hexToBin(txHex))).reverse());
}

// Node reject codes for "this exact transaction is already known" (BCHN; same list as cashscript's
// ElectrumNetworkProvider). Deliberately exact: a loose match such as "duplicate" would also hit
// bad-txns-inputs-duplicate, an invalid transaction.
const ALREADY_KNOWN = ['txn-already-in-mempool', 'txn-already-known', 'transaction already in block chain'];
const isAlreadyKnown = (e: unknown): boolean =>
  e instanceof NetworkProviderTransactionAlreadySubmittedError
  || ALREADY_KNOWN.some((p) => String((e as { message?: unknown })?.message ?? e).toLowerCase().includes(p));

export class LeashPaywall {
  readonly nonces = new Map<string, NonceRecord>();
  private readonly payToLock: string;
  private readonly ttl: number;
  private readonly maxNonces: number;
  private readonly minConf: number;
  private readonly confirmTimeout: number;
  private readonly now: () => number;

  constructor(readonly cfg: PaywallConfig) {
    const prefix = cfg.network === 'bch:bchtest' ? 'bchtest:' : 'bitcoincash:';
    if (!cfg.payTo.startsWith(prefix)) throw new Error(`payTo ${cfg.payTo} does not match network ${cfg.network}`);
    this.payToLock = binToHex(lockingBytecodeOf(cfg.payTo));
    if (!/^76a914[0-9a-f]{40}88ac$/.test(this.payToLock)) throw new Error('payTo must be a P2PKH address');
    // A payment output below dust is non-standard: such a route could never be paid.
    for (const r of cfg.routes) {
      if (r.price < DUST) throw new Error(`route ${r.method.toUpperCase()} ${r.path} price ${r.price} sats is below dust (${DUST})`);
    }
    this.ttl = cfg.nonceTtlMs ?? 120_000;
    this.maxNonces = cfg.maxNonces ?? 10_000;
    if (!Number.isInteger(this.maxNonces) || this.maxNonces < 1) throw new Error('maxNonces must be a positive integer');
    this.minConf = cfg.minConfirmations ?? 0;
    if (!Number.isInteger(this.minConf) || this.minConf < 0) throw new Error('minConfirmations must be a non-negative integer');
    if (this.minConf > 0 && !cfg.confirmations) throw new Error('minConfirmations > 0 needs a confirmations(txid) source');
    this.confirmTimeout = cfg.confirmTimeoutMs ?? 2 * 60 * 60_000;
    this.now = cfg.now ?? Date.now;
  }

  private route(req: PlainRequest) {
    return this.cfg.routes.find((r) => r.method.toUpperCase() === req.method.toUpperCase() && r.path === req.path);
  }

  /**
   * Unpaid requests create nonces, so the store must stay bounded. Map order is issue order and every
   * nonce lives `ttl`, so expired ones sit at the front: drop them until the first live one (O(1)
   * amortised, not a full scan per request). If still full, evict the oldest. A client whose nonce was
   * evicted gets "unknown nonce" before anything is broadcast, so it loses no money. A nonce whose
   * broadcast is in flight ('pending') or that is paid and waiting ('settling') is never evicted; a
   * settling one is dropped only after confirmTimeoutMs (e.g. its payment was double-spent).
   */
  private pruneNonces(): void {
    const now = this.now();
    for (const [k, v] of this.nonces) {
      if (v.state === 'pending') continue;
      if (v.state === 'settling') { if (v.expires < now) this.nonces.delete(k); continue; }
      if (v.expires >= now) break;
      this.nonces.delete(k);
    }
    if (this.nonces.size < this.maxNonces) return;
    for (const [k, v] of this.nonces) {
      if (v.state === 'pending' || v.state === 'settling') continue;
      this.nonces.delete(k);
      if (this.nonces.size < this.maxNonces) break;
    }
  }

  private challenge(route: PaidRoute, error?: string): PlainResponse {
    this.pruneNonces();
    if (this.nonces.size >= this.maxNonces) {
      return { status: 429, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'too many in-flight payments' }) };
    }
    const nonce = randomBytes(16).toString('hex');
    const url = this.cfg.origin + route.path;
    this.nonces.set(nonce, { method: route.method.toUpperCase(), path: route.path, url, price: route.price, expires: this.now() + this.ttl, state: 'open' });
    const body: PaymentRequired = {
      x402Version: X402_VERSION,
      ...(error && { error }),
      resource: { url, description: route.description },
      accepts: [{
        scheme: SCHEME_LEASH, network: this.cfg.network, amount: route.price.toString(), asset: 'BCH', payTo: this.cfg.payTo,
        maxTimeoutSeconds: Math.floor(this.ttl / 1000),
        extra: { nonce, receipt: 'LSH1', requestHash: 'sha256(len|nonce|len|method|len16|url|sha256(body))' },
      }],
    };
    return { status: 402, headers: { 'PAYMENT-REQUIRED': encodeHeader(body), 'content-type': 'application/json' }, body: JSON.stringify(body) };
  }

  /** Checks a payment without side effects. Returns the reason on failure. */
  verify(req: PlainRequest, route: PaidRoute, p: PaymentPayload): { ok: true; nonce: string; txHex: string } | { ok: false; reason: string } {
    if (p?.x402Version !== X402_VERSION) return { ok: false, reason: 'unsupported x402Version' };
    if (p.accepted?.scheme !== SCHEME_LEASH) return { ok: false, reason: 'unsupported scheme' };
    if (p.accepted.network !== this.cfg.network) return { ok: false, reason: 'wrong network' };
    const nonce = p.accepted.extra?.nonce;
    const rec = typeof nonce === 'string' ? this.nonces.get(nonce) : undefined;
    if (!rec) return { ok: false, reason: 'unknown nonce' };
    if (rec.state !== 'open') return { ok: false, reason: 'nonce already used' };
    if (rec.expires < this.now()) return { ok: false, reason: 'nonce expired' };
    if (rec.method !== req.method.toUpperCase() || rec.path !== req.path) return { ok: false, reason: 'nonce issued for another resource' };
    const txHex = p.payload?.transaction;
    if (typeof txHex !== 'string' || !/^([0-9a-f]{2})+$/i.test(txHex)) return { ok: false, reason: 'payload.transaction must be hex' };
    const tx = decodeTransaction(hexToBin(txHex));
    if (typeof tx === 'string') return { ok: false, reason: `undecodable transaction: ${tx}` };
    if (tx.outputs.length !== 3) return { ok: false, reason: 'not a leash payment (expected 3 outputs)' };
    const pay = tx.outputs[1];
    if (binToHex(pay.lockingBytecode) !== this.payToLock) return { ok: false, reason: 'payment output does not pay payTo' };
    if (pay.token) return { ok: false, reason: 'payment output carries tokens' };
    if (pay.valueSatoshis < rec.price) return { ok: false, reason: `underpaid: ${pay.valueSatoshis} < ${rec.price} sats` };
    const receiptHash = parseReceipt(tx.outputs[2].lockingBytecode);
    if (!receiptHash) return { ok: false, reason: 'missing LSH1 receipt' };
    const expected = computeRequestHash({ challengeNonce: nonce, method: rec.method, url: rec.url, body: req.body });
    if (receiptHash !== expected) return { ok: false, reason: 'receipt does not bind this request (nonce/method/url/body)' };
    return { ok: true, nonce, txHex };
  }

  async handle(req: PlainRequest): Promise<PlainResponse> {
    const route = this.route(req);
    if (!route) return { status: 404, body: 'not found' };
    // HTTP header names are case-insensitive; adapters other than node:http may keep the sender's casing.
    const header = req.headers['payment-signature']
      ?? Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'payment-signature')?.[1];
    if (!header) return this.challenge(route);
    let payload: PaymentPayload;
    try { payload = decodeHeader<PaymentPayload>(header); } catch { return this.challenge(route, 'malformed PAYMENT-SIGNATURE'); }
    const waiting = this.nonces.get(String(payload?.accepted?.extra?.nonce));
    if (waiting?.txid && (waiting.state === 'settling' || waiting.state === 'pending')) return this.resume(req, route, waiting, payload);
    const v = this.verify(req, route, payload);
    if (!v.ok) return this.challenge(route, v.reason);
    const rec = this.nonces.get(v.nonce)!;
    rec.state = 'pending'; // single-threaded: blocks a concurrent replay while the broadcast is in flight
    // Known before the broadcast, so an identical retry arriving while it is in flight goes to resume()
    // and gets 202, not "nonce already used" (Jules review round 3, 2026-10-14).
    rec.txid = computeTxid(v.txHex);
    rec.txHex = v.txHex.toLowerCase();
    let txid: string;
    try {
      txid = await this.cfg.provider.sendRawTransaction(v.txHex);
    } catch (e: any) {
      // The payer (or an earlier attempt) may already have broadcast this exact transaction. That is a
      // payment, not a failure, but only if the node really holds it: the error text alone is not trusted.
      const known = isAlreadyKnown(e) ? await this.heldByNode(v.txHex) : undefined;
      if (!known) {
        rec.state = 'open';
        rec.txid = undefined;
        rec.txHex = undefined;
        const settle: SettlementResponse = { success: false, network: this.cfg.network, errorReason: `broadcast rejected: ${String(e?.message ?? e).slice(0, 300)}` };
        const r = this.challenge(route, settle.errorReason);
        return { ...r, headers: { ...r.headers, 'PAYMENT-RESPONSE': encodeHeader(settle) } };
      }
      txid = known;
    }
    rec.txid = txid;
    rec.txHex = v.txHex.toLowerCase();
    if (this.minConf > 0) {
      Object.assign(rec, { state: 'settling', expires: this.now() + this.confirmTimeout });
      return this.awaiting(txid, 0);
    }
    return this.serve(req, route, rec, txid);
  }

  /** txid if the node returns exactly this transaction (mempool or chain), else undefined. */
  private async heldByNode(txHex: string): Promise<string | undefined> {
    const txid = computeTxid(txHex);
    try {
      const raw = await this.cfg.provider.getRawTransaction(txid);
      return typeof raw === 'string' && raw.toLowerCase() === txHex.toLowerCase() ? txid : undefined;
    } catch {
      return undefined;
    }
  }

  private async serve(req: PlainRequest, route: PaidRoute, rec: NonceRecord, txid: string): Promise<PlainResponse> {
    // 'used' before the handler runs, so a concurrent replay during it still gets "nonce already used".
    rec.state = 'used';
    try {
      const content = await route.handler(req);
      const settle: SettlementResponse = { success: true, transaction: txid, network: this.cfg.network };
      return { ...content, headers: { ...content.headers, 'PAYMENT-RESPONSE': encodeHeader(settle) } };
    } catch (err) {
      // The money has moved; the handler failed. Keep the nonce reserved so re-sending the same payment
      // gets the content (via resume), instead of the payer losing it or paying twice.
      Object.assign(rec, { state: 'settling', expires: Math.max(rec.expires, this.now() + this.confirmTimeout) });
      throw err;
    }
  }

  /** 202, not 402: the payment is made, so no new challenge that a generic x402 client would pay again. */
  private awaiting(txid: string, have: number): PlainResponse {
    const settle: SettlementResponse = {
      success: false, transaction: txid, network: this.cfg.network, errorReason: `awaiting ${this.minConf} confirmation(s), have ${have}`,
    };
    return {
      status: 202,
      headers: { 'PAYMENT-RESPONSE': encodeHeader(settle), 'retry-after': '60', 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'awaiting-confirmations', transaction: txid, required: this.minConf, confirmations: have }),
    };
  }

  /** The client re-sends its broadcast payment: serve once it has minConfirmations. */
  private async resume(req: PlainRequest, route: PaidRoute, rec: NonceRecord, p: PaymentPayload): Promise<PlainResponse> {
    if (rec.method !== req.method.toUpperCase() || rec.path !== req.path) return this.challenge(route, 'nonce issued for another resource');
    const tx = p?.payload?.transaction;
    if (typeof tx !== 'string' || tx.toLowerCase() !== rec.txHex) return this.challenge(route, 'nonce is awaiting confirmation of another transaction');
    const txid = rec.txid!;
    if (rec.state === 'pending') return this.awaiting(txid, 0); // a concurrent retry is checking right now
    if (this.minConf === 0) return this.serve(req, route, rec, txid); // broadcast already counted; retry after a handler failure
    rec.state = 'pending';
    let have = 0;
    try { have = await this.cfg.confirmations!(txid); } catch { have = 0; }
    if (have >= this.minConf) return this.serve(req, route, rec, txid);
    rec.state = 'settling';
    return this.awaiting(txid, have);
  }
}
