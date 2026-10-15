// Chain access for the web demo: Electrum over WebSocket (CashScript's provider), proven UTXO age,
// and the leash journal reconstructed from the contract's transaction history.
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, encodeCashAddress, hexToBin, lockingBytecodeToCashAddress, sha256 } from '@bitauth/libauth';
import { ElectrumNetworkProvider, type SpendableUtxo } from 'cashscript';
import { AgentLeash, decodeState, parseReceipt, type LeashState } from '../../src/browser.js';
import type { NetConfig } from './config.js';

const providers = new Map<string, ElectrumNetworkProvider>();
export function providerFor(net: NetConfig): ElectrumNetworkProvider {
  let p = providers.get(net.name);
  if (!p) {
    p = new ElectrumNetworkProvider(net.cashscript as any, { hostname: net.electrum } as any);
    providers.set(net.name, p);
  }
  return p;
}

export const scripthashOf = (lockingBytecode: Uint8Array): string => binToHex(sha256.hash(lockingBytecode).reverse());

export function lockOf(address: string): Uint8Array {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(`bad address: ${r}`);
  return r.bytecode;
}

export function addressOf(lock: Uint8Array, net: NetConfig, tokens = false): string {
  const r = lockingBytecodeToCashAddress({ bytecode: lock, prefix: net.prefix, tokenSupport: tokens });
  return typeof r === 'string' ? `script ${binToHex(lock).slice(0, 16)}…` : r.address;
}

export function p2pkhAddress(pkh: Uint8Array, net: NetConfig, tokens = false): string {
  const r = encodeCashAddress({ prefix: net.prefix, type: tokens ? 'p2pkhWithTokens' : 'p2pkh', payload: pkh });
  return typeof r === 'string' ? r : r.address;
}

/** Blocks of age BIP68 will see for this UTXO in the next block; 0 if unconfirmed. Capped at 65535. */
export async function ageOf(provider: ElectrumNetworkProvider, u: SpendableUtxo): Promise<bigint> {
  const tip = await provider.getBlockHeight();
  const list = await provider.performRequest('blockchain.scripthash.listunspent', scripthashOf(hexToBin(u.lockingBytecode))) as any[];
  const row = list.find((x) => x.tx_hash === u.txid && x.tx_pos === u.vout);
  if (!row || row.height <= 0) return 0n;
  const age = BigInt(tip + 1 - row.height);
  return age > 65535n ? 65535n : age;
}

export type JournalKind = 'genesis' | 'payment' | 'topup' | 'withdraw' | 'other';
export interface JournalRow {
  txid: string;
  height: number; // <= 0: mempool
  kind: JournalKind;
  amount?: bigint;
  fee?: bigint;
  payee?: string;
  receipt?: string;
  state?: LeashState;
  balance?: bigint;
}

const txCache = new Map<string, ReturnType<typeof decodeTransaction>>();
async function getTx(provider: ElectrumNetworkProvider, txid: string) {
  let tx = txCache.get(txid);
  if (!tx) {
    const hex = await provider.performRequest('blockchain.transaction.get', txid, false) as string;
    tx = decodeTransaction(hexToBin(hex));
    if (typeof tx !== 'string') txCache.set(txid, tx);
  }
  if (typeof tx === 'string') throw new Error(tx);
  return tx;
}

/** Every transaction that touched the leash address, oldest first, classified. */
export async function journal(leash: AgentLeash, net: NetConfig, limit = 40): Promise<JournalRow[]> {
  const provider = leash.provider as ElectrumNetworkProvider;
  const lock = lockOf(leash.tokenAddress);
  const lockHex = binToHex(lock);
  const hist = await provider.performRequest('blockchain.scripthash.get_history', scripthashOf(lock)) as { tx_hash: string; height: number }[];
  // confirmed by height, mempool (0 / -1) last
  const byHeight = [...hist].sort((a, b) => (a.height <= 0 ? 1e12 : a.height) - (b.height <= 0 ? 1e12 : b.height)).slice(-limit);
  const txs = new Map<string, Awaited<ReturnType<typeof getTx>>>();
  for (const h of byHeight) txs.set(h.tx_hash, await getTx(provider, h.tx_hash));
  // Mempool entries all have height 0, so their order is arbitrary: put every tx after the txs it spends
  // (a chain of unconfirmed payments is normal for one state coin).
  const sorted: typeof byHeight = [];
  const placed = new Set<string>();
  const visit = (h: (typeof byHeight)[number], depth = 0) => {
    if (placed.has(h.tx_hash) || depth > byHeight.length) return;
    for (const i of txs.get(h.tx_hash)!.inputs) {
      const parent = byHeight.find((x) => x.tx_hash === binToHex(i.outpointTransactionHash));
      if (parent && parent.height <= 0 && h.height <= 0) visit(parent, depth + 1);
    }
    if (!placed.has(h.tx_hash)) { placed.add(h.tx_hash); sorted.push(h); }
  };
  for (const h of byHeight) visit(h);
  const valueOf = new Map<string, bigint>(); // "txid:vout" -> sats, for contract outputs we have seen
  const rows: JournalRow[] = [];
  for (const h of sorted) {
    const tx = txs.get(h.tx_hash)!;
    tx.outputs.forEach((o, i) => { if (binToHex(o.lockingBytecode) === lockHex) valueOf.set(`${h.tx_hash}:${i}`, o.valueSatoshis); });
    const spentIn = tx.inputs.map((i) => valueOf.get(`${binToHex(i.outpointTransactionHash)}:${i.outpointIndex}`));
    const fromContract = spentIn.reduce<bigint>((s, v) => s + (v ?? 0n), 0n);
    const stateOut = tx.outputs.find((o) => binToHex(o.lockingBytecode) === lockHex && o.token?.nft);
    const state = stateOut?.token?.nft ? decodeState(binToHex(stateOut.token.nft.commitment)) : undefined;
    const receipt = tx.outputs.length === 3 ? parseReceipt(tx.outputs[2].lockingBytecode) : undefined;
    const row: JournalRow = { txid: h.tx_hash, height: h.height, kind: 'other', state, balance: stateOut?.valueSatoshis };
    if (receipt && stateOut && tx.inputs.length === 1) {
      row.kind = 'payment';
      row.receipt = receipt;
      row.amount = tx.outputs[1].valueSatoshis;
      row.payee = addressOf(tx.outputs[1].lockingBytecode, net);
      if (spentIn[0] !== undefined) row.fee = spentIn[0] - stateOut.valueSatoshis - row.amount;
    } else if (stateOut && fromContract === 0n) {
      row.kind = 'genesis';
      row.amount = stateOut.valueSatoshis;
    } else if (stateOut) {
      row.kind = 'topup';
      row.amount = stateOut.valueSatoshis - fromContract;
    } else if (fromContract > 0n) {
      row.kind = 'withdraw';
      row.amount = fromContract;
    }
    rows.push(row);
  }
  return rows;
}

export async function stateNow(leash: AgentLeash): Promise<{ utxo?: SpendableUtxo; state?: LeashState; age: bigint; tip: number; stray: number }> {
  const provider = leash.provider as ElectrumNetworkProvider;
  const [{ state, stray }, tip] = await Promise.all([leash.getUtxos(), provider.getBlockHeight()]);
  if (!state) return { age: 0n, tip, stray: stray.length };
  return { utxo: state, state: AgentLeash.stateOf(state), age: await ageOf(provider, state), tip, stray: stray.length };
}
