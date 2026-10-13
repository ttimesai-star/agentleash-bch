// HTTP 402 paywall for AgentLeash payments, in the x402 v2 message shape:
//   402 + header PAYMENT-REQUIRED  (base64 JSON PaymentRequired)
//   retry with header PAYMENT-SIGNATURE (base64 JSON PaymentPayload)
//   200 + header PAYMENT-RESPONSE  (base64 JSON SettlementResponse)
//
// Scheme `leash` (ours, not part of the x402 spec): the payload is a fully signed BCH transaction in the
// AgentLeash `pay` shape — out[1] pays `payTo`, out[2] is the receipt OP_RETURN "LSH1" <requestHash>,
// where requestHash = computeRequestHash(nonce, method, resource url, body). The server checks the
// payment and the binding, consumes the one-time nonce, then settles by broadcasting (mempool, 0-conf).
//
// Only `leash` is implemented. The standard `exact` scheme (@x402/bch) is NOT offered yet: advertising
// it before it works would be dishonest.
//
// Framework-free: `handle()` maps a plain request to a plain response, so it runs under node:http,
// tests, or any other server.
import { randomBytes } from 'node:crypto';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import type { NetworkProvider } from 'cashscript';
import { computeRequestHash, parseReceipt } from './receipt.js';
import { lockingBytecodeOf } from './leash.js';

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

interface NonceRecord { method: string; path: string; url: string; price: bigint; expires: number; state: 'open' | 'pending' | 'used' }

export class LeashPaywall {
  readonly nonces = new Map<string, NonceRecord>();
  private readonly payToLock: string;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(readonly cfg: PaywallConfig) {
    const prefix = cfg.network === 'bch:bchtest' ? 'bchtest:' : 'bitcoincash:';
    if (!cfg.payTo.startsWith(prefix)) throw new Error(`payTo ${cfg.payTo} does not match network ${cfg.network}`);
    this.payToLock = binToHex(lockingBytecodeOf(cfg.payTo));
    if (!/^76a914[0-9a-f]{40}88ac$/.test(this.payToLock)) throw new Error('payTo must be a P2PKH address');
    this.ttl = cfg.nonceTtlMs ?? 120_000;
    this.now = cfg.now ?? Date.now;
  }

  private route(req: PlainRequest) {
    return this.cfg.routes.find((r) => r.method.toUpperCase() === req.method.toUpperCase() && r.path === req.path);
  }

  private challenge(route: PaidRoute, error?: string): PlainResponse {
    for (const [k, v] of this.nonces) if (v.expires < this.now() && v.state !== 'pending') this.nonces.delete(k);
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
    const header = req.headers['payment-signature'] ?? req.headers['PAYMENT-SIGNATURE'];
    if (!header) return this.challenge(route);
    let payload: PaymentPayload;
    try { payload = decodeHeader<PaymentPayload>(header); } catch { return this.challenge(route, 'malformed PAYMENT-SIGNATURE'); }
    const v = this.verify(req, route, payload);
    if (!v.ok) return this.challenge(route, v.reason);
    const rec = this.nonces.get(v.nonce)!;
    rec.state = 'pending'; // single-threaded: blocks a concurrent replay while the broadcast is in flight
    let txid: string;
    try {
      txid = await this.cfg.provider.sendRawTransaction(v.txHex);
    } catch (e: any) {
      rec.state = 'open';
      const settle: SettlementResponse = { success: false, network: this.cfg.network, errorReason: `broadcast rejected: ${String(e?.message ?? e).slice(0, 300)}` };
      const r = this.challenge(route, settle.errorReason);
      return { ...r, headers: { ...r.headers, 'PAYMENT-RESPONSE': encodeHeader(settle) } };
    }
    rec.state = 'used';
    const content = await route.handler(req);
    const settle: SettlementResponse = { success: true, transaction: txid, network: this.cfg.network };
    return { ...content, headers: { ...content.headers, 'PAYMENT-RESPONSE': encodeHeader(settle) } };
  }
}
