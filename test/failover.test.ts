// Electrum failover (src/failover.ts): connection failures and hangs move to the next server; a node's
// answer (rejected broadcast, unknown tx) is returned as is and never retried elsewhere.
import { describe, expect, it } from 'vitest';
import { FailoverProvider, isConnectionError, type ElectrumLike } from '../src/failover.js';

type Behaviour = 'ok' | 'down' | 'hang' | 'reject';
function fake(host: string, b: { current: Behaviour }, calls: string[]): ElectrumLike {
  const act = async <T>(what: string, v: T): Promise<T> => {
    calls.push(`${host}:${what}`);
    if (b.current === 'down') throw new Error('Failed to establish connection: WebSocket: 1006: .');
    if (b.current === 'hang') return new Promise<T>(() => {});
    if (b.current === 'reject') throw new Error('the transaction was rejected by network rules.\n\nmandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)');
    return v;
  };
  return {
    network: 'chipnet' as any,
    getUtxos: (a) => act('utxos', [{ txid: host, vout: 0, satoshis: 1n, lockingBytecode: a }]),
    getUtxosForLockingBytecode: () => act('utxos', []),
    getBlockHeight: () => act('height', host === 'a' ? 1 : 2),
    getRawTransaction: (t) => act('raw', `${host}:${t}`),
    sendRawTransaction: () => act('send', `txid-from-${host}`),
    performRequest: (n) => act(n, { host }),
  };
}

function mk(a: Behaviour, b: Behaviour, timeoutMs = 50) {
  const calls: string[] = [];
  const switches: string[] = [];
  const state = { a: { current: a }, b: { current: b } };
  const p = new FailoverProvider('chipnet' as any, ['a', 'b'], { timeoutMs, broadcastTimeoutMs: timeoutMs, onSwitch: (f, t) => switches.push(`${f}->${t}`) },
    (h) => fake(h, (state as any)[h], calls));
  return { p, calls, switches, state };
}

describe('FailoverProvider', () => {
  it('uses the first server while it works', async () => {
    const m = mk('ok', 'ok');
    expect(await m.p.getBlockHeight()).toBe(1);
    expect(m.calls).toEqual(['a:height']);
    expect(m.p.current).toBe('a');
  });

  it('a server that is down: the request goes to the next one, which stays current', async () => {
    const m = mk('down', 'ok');
    expect(await m.p.getBlockHeight()).toBe(2);
    expect(await m.p.performRequest('blockchain.scripthash.listunspent', 'x')).toEqual({ host: 'b' });
    expect(m.calls).toEqual(['a:height', 'b:height', 'b:blockchain.scripthash.listunspent']);
    expect(m.switches).toEqual(['a->b']);
    expect(m.p.current).toBe('b');
  });

  it('a hanging server times out and fails over', async () => {
    const m = mk('hang', 'ok', 30);
    expect(await m.p.getRawTransaction('t1')).toBe('b:t1');
    expect(m.p.current).toBe('b');
  });

  it('a rejected broadcast is the network speaking: thrown verbatim, never retried on another server', async () => {
    const m = mk('reject', 'ok');
    await expect(m.p.sendRawTransaction('00')).rejects.toThrow(/mandatory-script-verify-flag-failed/);
    expect(m.calls).toEqual(['a:send']);
    expect(m.p.current).toBe('a');
  });

  it('a broadcast whose server is down goes out through the next one', async () => {
    const m = mk('down', 'ok');
    expect(await m.p.sendRawTransaction('00')).toBe('txid-from-b');
  });

  it('all servers down: the last connection error is thrown; it wraps around when the first comes back', async () => {
    const m = mk('down', 'down');
    await expect(m.p.getBlockHeight()).rejects.toThrow(/Failed to establish connection/);
    m.state.a.current = 'ok';
    expect(await m.p.getBlockHeight()).toBe(1);
  });

  it('isConnectionError: connection problems yes, node refusals no', () => {
    for (const m of [
      'Failed to establish connection: WebSocket: 1006: .', 'connect ECONNREFUSED 1.2.3.4:50004', 'Request timed out', 'socket hang up',
      'Failed to fetch', 'fetch failed', 'ENETUNREACH', 'EPIPE',
    ]) expect(isConnectionError(new Error(m))).toBe(true);
    // nested error objects
    expect(isConnectionError({ originalError: new Error('WebSocket connection closed') })).toBe(true);
    expect(isConnectionError({ cause: new Error('ENETUNREACH') })).toBe(true);
    for (const m of ['non-BIP68-final', 'mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)', 'txn-already-known', 'No such mempool or blockchain transaction']) expect(isConnectionError(new Error(m))).toBe(false);
  });

  it('withTimeout does not leak unhandled rejections if promise rejects after timeout', async () => {
    let rejectLate!: (err: Error) => void;
    const hangingPromise = new Promise((_, reject) => { rejectLate = reject; });
    const p = new FailoverProvider('chipnet' as any, ['a'], { timeoutMs: 10 }, () => ({
      network: 'chipnet' as any,
      getUtxos: () => hangingPromise as any,
      getUtxosForLockingBytecode: () => hangingPromise as any,
      getBlockHeight: () => hangingPromise as any,
      getRawTransaction: () => hangingPromise as any,
      sendRawTransaction: () => hangingPromise as any,
      performRequest: () => hangingPromise as any,
    }));
    await expect(p.getBlockHeight()).rejects.toThrow(/timed out/);
    // now late reject the promise after timeout has passed
    rejectLate(new Error('late connection reset'));
    await new Promise((res) => setTimeout(res, 20));
  });

  it('needs at least one host', () => {
    expect(() => new FailoverProvider('chipnet' as any, [])).toThrow(/at least one host/);
  });
});

describe('isConnectionError on wrapped errors', () => {
  it('a wrapped node refusal is not a connection error; a wrapped connection error is', () => {
    expect(isConnectionError({ message: 'broadcast failed', originalError: new Error('non-BIP68-final (code 64)') })).toBe(false);
    expect(isConnectionError({ message: 'broadcast failed', originalError: { cause: new Error('connect ECONNREFUSED 1.2.3.4') } })).toBe(true);
    expect(isConnectionError(null)).toBe(false);
  });
});
