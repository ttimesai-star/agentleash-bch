// Electrum failover for the demo: one public Electrum server going down (or hanging on the WebSocket
// connect, seen with chipnet.bch.ninja) must not take the live demo down with it.
//
// A request goes to the current server; on a CONNECTION failure or a timeout it is retried on the next
// server, which then becomes current. A node's answer (e.g. a broadcast rejected by the network rules, an
// unknown txid) is NOT a connection failure: it is returned as is, never retried elsewhere, so a refusal is
// never hidden by asking another server. Retrying a broadcast that timed out is safe: the same transaction
// is at worst "already known", which callers already handle (LeashPaywall checks the node holds it).
//
// Browser-safe. CashScript's ElectrumNetworkProvider connects per request, so switching costs nothing.
import { ElectrumNetworkProvider, type Network, type NetworkProvider, type SpendableUtxo } from 'cashscript';

/** What we need from a provider: CashScript's interface plus Electrum's raw request. */
export interface ElectrumLike extends NetworkProvider {
  performRequest(name: string, ...params: (string | number | boolean)[]): Promise<unknown>;
}

export interface FailoverOptions {
  /** Per-request timeout (ms) for reads. Default 12 000. */
  timeoutMs?: number;
  /** Timeout for broadcasts. Default 20 000. */
  broadcastTimeoutMs?: number;
  /** Called when the current server changes. */
  onSwitch?: (from: string, to: string, why: string) => void;
}

const CONNECTION = /failed to establish connection|websocket|timed? ?out|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ETIMEDOUT|not connected|connection (?:closed|lost|refused|reset)|disconnected|socket hang up|network ?error|fetch failed|failed to fetch|ENETUNREACH|EHOSTUNREACH|EPIPE|broken pipe/i;

/** True if the error, or the error it wraps (`originalError` / `cause`, Jules AL3-01), is a connection problem. */
export const isConnectionError = (e: unknown): boolean => {
  const texts: string[] = [];
  let cur: any = e;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 4; depth++) {
    texts.push(String(cur?.message ?? cur));
    cur = cur?.originalError ?? cur?.cause;
  }
  return texts.some((t) => CONNECTION.test(t));
};

export class TimeoutError extends Error {
  constructor(what: string, ms: number) { super(`${what} timed out after ${ms} ms`); this.name = 'TimeoutError'; }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  p.catch(() => {}); // prevent unhandled rejection if p rejects after timeout
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, reject) => { t = setTimeout(() => reject(new TimeoutError(what, ms)), ms); }),
  ]);
}

export class FailoverProvider implements ElectrumLike {
  readonly network: Network;
  private readonly providers: ElectrumLike[];
  private i = 0;

  /**
   * @param hosts Electrum hostnames in order of preference (at least one).
   * @param make  Provider per host; default CashScript's ElectrumNetworkProvider.
   */
  constructor(network: Network, readonly hosts: string[], private o: FailoverOptions = {}, make?: (host: string) => ElectrumLike) {
    if (!hosts.length) throw new Error('FailoverProvider needs at least one host');
    this.network = network;
    const mk = make ?? ((h: string) => new ElectrumNetworkProvider(network, { hostname: h }) as unknown as ElectrumLike);
    this.providers = hosts.map(mk);
  }

  /** Hostname currently in use. */
  get current(): string { return this.hosts[this.i]; }

  private async run<T>(what: string, fn: (p: ElectrumLike) => Promise<T>, ms: number): Promise<T> {
    let lastErr: unknown;
    for (let n = 0; n < this.providers.length; n++) {
      const idx = (this.i + n) % this.providers.length;
      try {
        const r = await withTimeout(fn(this.providers[idx]), ms, `${what} on ${this.hosts[idx]}`);
        if (idx !== this.i) {
          this.o.onSwitch?.(this.hosts[this.i], this.hosts[idx], String((lastErr as Error)?.message ?? lastErr));
          this.i = idx;
        }
        return r;
      } catch (e) {
        if (!(e instanceof TimeoutError) && !isConnectionError(e)) throw e; // the server answered: not ours to retry
        lastErr = e;
      }
    }
    throw lastErr;
  }

  getUtxos(address: string): Promise<SpendableUtxo[]> {
    return this.run('getUtxos', (p) => p.getUtxos(address), this.o.timeoutMs ?? 12_000);
  }
  getUtxosForLockingBytecode(lockingBytecode: Uint8Array | string): Promise<SpendableUtxo[]> {
    return this.run('getUtxos', (p) => p.getUtxosForLockingBytecode(lockingBytecode), this.o.timeoutMs ?? 12_000);
  }
  getBlockHeight(): Promise<number> {
    return this.run('getBlockHeight', (p) => p.getBlockHeight(), this.o.timeoutMs ?? 12_000);
  }
  getRawTransaction(txid: string): Promise<string> {
    return this.run('getRawTransaction', (p) => p.getRawTransaction(txid), this.o.timeoutMs ?? 12_000);
  }
  sendRawTransaction(txHex: string): Promise<string> {
    return this.run('broadcast', (p) => p.sendRawTransaction(txHex), this.o.broadcastTimeoutMs ?? 20_000);
  }
  performRequest(name: string, ...params: (string | number | boolean)[]): Promise<any> {
    const ms = name === 'blockchain.transaction.broadcast' ? this.o.broadcastTimeoutMs ?? 20_000 : this.o.timeoutMs ?? 12_000;
    return this.run(name, (p) => p.performRequest(name, ...params), ms);
  }
}

/** Public Electrum servers checked on 16.10.2026 (WebSocket, from Node). */
export const ELECTRUM_HOSTS: Record<'chipnet' | 'mainnet', string[]> = {
  chipnet: ['chipnet.bch.ninja', 'chipnet.imaginary.cash'],
  mainnet: ['bch.imaginary.cash', 'blackie.c3-soft.com'],
};
