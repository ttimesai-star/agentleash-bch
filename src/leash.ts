import { binToHex, cashAddressToLockingBytecode, hexToBin, secp256k1, hash160 } from '@bitauth/libauth';
import {
  Contract, SignatureTemplate, TransactionBuilder,
  type NetworkProvider, type Unlocker, type SpendableUtxo as Utxo, type Output,
} from 'cashscript';
import artifact from '../artifacts/AgentLeash.artifact.js';
import { decodeState, encodeState, nextState, type LeashState } from './state.js';
import { receiptLockingBytecode } from './receipt.js';

export const MIN_STATE_VALUE = 1000n;
export const DUST = 546n;

/** Size of a P2PKH unlocking bytecode with a Schnorr signature: PUSH65 <sig> PUSH33 <pubkey>. */
export const P2PKH_UNLOCK_BYTES = 1 + 65 + 1 + 33;

/** True for `placeholderP2PKHUnlocker(...)` from cashscript: a WizardConnect wallet fills the input later. */
export const isPlaceholder = (u: Unlocker): boolean => (u as { placeholder?: boolean }).placeholder === true;

/**
 * Bytes a wallet adds when it signs placeholder inputs. A placeholder unlocker produces an EMPTY
 * unlocking bytecode; CashScript's fee check already adds these bytes and refuses an underpaying
 * transaction, so `withAutoFee` adds them up front instead of converging through that error.
 */
export const placeholderBytes = (unlockers: Unlocker[]): number => unlockers.filter(isPlaceholder).length * P2PKH_UNLOCK_BYTES;

/**
 * Build with a provisional fee, measure the signed size, rebuild with size * feeRate (+ margin) and
 * repeat until the fee covers the size of the transaction actually returned. Re-measuring matters when
 * the fee decides whether a change output exists (Jules review AL-04): the final transaction can be
 * one output larger than the probe.
 */
export function withAutoFee(build: (fee: bigint) => TransactionBuilder, feeRate = 1, margin = 5n, extraBytes = 0): { builder: TransactionBuilder; fee: bigint } {
  const need = (hex: string) => BigInt(Math.ceil((hex.length / 2 + extraBytes) * feeRate)) + margin;
  let fee: bigint | undefined;
  let lastErr: unknown;
  for (const probeFee of [2000n, 1000n, 600n]) {
    try { fee = need(build(probeFee).build()); break; } catch (e) { lastErr = e; }
  }
  if (fee === undefined) throw lastErr;
  for (let i = 0; i < 6; i++) {
    const builder = build(fee);
    let hex: string;
    try { hex = builder.build(); }
    catch (e: any) {
      // the lower fee added an output (e.g. change crossed the dust line): pay for ~one more output
      if (!/lower than the standard minimum fee/.test(String(e?.message))) throw e;
      fee += 40n;
      continue;
    }
    const required = need(hex);
    if (required <= fee) return { builder, fee };
    fee = required;
  }
  throw new Error('fee estimation did not converge');
}

export interface LeashParams {
  /** Category of the state NFT, hex as shown by wallets / CashScript (= genesis input txid). */
  stateCategory: string;
  /** hash160 of the agent's compressed public key. */
  agentPkh: Uint8Array;
  /** Locking bytecode (P2PKH, 25 bytes) of the owner. */
  ownerLock: Uint8Array;
  /** 1 to 3 allow-listed recipient locking bytecodes. */
  allow: Uint8Array[];
  /** Satoshis per window. */
  limit: bigint;
  /** Window length in blocks (1..65535). */
  period: bigint;
  /** Max miner fee per agent payment, satoshis. */
  maxFee: bigint;
}

/** Introspection returns the category in VM byte order: the reverse of the display hex. */
export function categoryToVmBytes(categoryHex: string): Uint8Array {
  const b = hexToBin(categoryHex);
  if (b.length !== 32) throw new Error('category must be 32 bytes');
  return b.slice().reverse();
}

export function lockingBytecodeOf(address: string): Uint8Array {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(`bad address ${address}: ${r}`);
  return r.bytecode;
}

export function p2pkhLock(pkh: Uint8Array): Uint8Array {
  return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

export function pkhOfPrivateKey(priv: Uint8Array): Uint8Array {
  const pub = secp256k1.derivePublicKeyCompressed(priv);
  if (typeof pub === 'string') throw new Error(pub);
  return hash160(pub);
}

/** Standard P2PKH locking bytecode: OP_DUP OP_HASH160 PUSH20 <pkh> OP_EQUALVERIFY OP_CHECKSIG. */
export const isP2pkhLock = (b: Uint8Array): boolean =>
  b.length === 25 && b[0] === 0x76 && b[1] === 0xa9 && b[2] === 0x14 && b[23] === 0x88 && b[24] === 0xac;
/** P2SH20: OP_HASH160 PUSH20 <hash> OP_EQUAL. */
export const isP2sh20Lock = (b: Uint8Array): boolean => b.length === 23 && b[0] === 0xa9 && b[1] === 0x14 && b[22] === 0x87;
/** P2SH32: OP_HASH256 PUSH32 <hash> OP_EQUAL. */
export const isP2sh32Lock = (b: Uint8Array): boolean => b.length === 35 && b[0] === 0xaa && b[1] === 0x20 && b[34] === 0x87;

export function validateParams(p: LeashParams): void {
  if (p.allow.length < 1 || p.allow.length > 3) throw new Error('allow-list must have 1..3 entries');
  if (p.allow.some((a) => a.length === 0)) throw new Error('empty allow-list entry would be anyone-can-spend');
  // Security review 16.10: only address templates (P2PKH / P2SH20 / P2SH32). Anything else is either
  // spendable by anyone (OP_1 = 0x51, OP_TRUE scripts, empty) or unspendable (OP_RETURN): a payment
  // there is a loss, and the agent could recover an anyone-can-spend output itself.
  for (const a of p.allow) {
    if (!isP2pkhLock(a) && !isP2sh20Lock(a) && !isP2sh32Lock(a)) {
      throw new Error(`allow-list entry ${binToHex(a)} is not a standard P2PKH/P2SH address script (anyone-can-spend or burn)`);
    }
  }
  if (p.agentPkh.length !== 20) throw new Error('agentPkh must be 20 bytes');
  if (!isP2pkhLock(p.ownerLock)) throw new Error('ownerLock must be a standard 25-byte P2PKH locking bytecode');
  if (binToHex(p.ownerLock.slice(3, 23)) === binToHex(p.agentPkh)) {
    // the agent key would also be the owner key: the owner path (withdraw everything) bypasses the limit
    throw new Error('agent key must differ from the owner key');
  }
  if (p.limit < DUST) throw new Error('limit below dust');
  if (p.period < 1n || p.period > 65535n) throw new Error('period must be 1..65535 blocks');
  if (p.maxFee < 0n) throw new Error('maxFee must be >= 0');
  const ownerHex = binToHex(p.ownerLock);
  if (p.allow.some((a) => binToHex(a) === ownerHex)) {
    // not a security hole (owner can withdraw anyway) but almost always a configuration mistake
    throw new Error('owner lock should not be in the allow-list');
  }
}

export interface PayArgs {
  stateUtxo: Utxo;
  agentPrivateKey: Uint8Array;
  /** Recipient: CashAddr or raw locking bytecode. */
  payTo: string | Uint8Array;
  amount: bigint;
  /** 32-byte request hash (hex or bytes) that goes into the LSH1 receipt. */
  requestHash: string | Uint8Array;
  /** Blocks of state-UTXO age to claim; must be <= real confirmations of stateUtxo. 0 for unconfirmed. */
  elapsedAdd: bigint;
  /** Miner fee in sats; default: measured size at 1 sat/byte (+5). Must be <= maxFee. */
  fee?: bigint;
}

export class AgentLeash {
  readonly contract: Contract<typeof artifact>;

  constructor(readonly params: LeashParams, readonly provider: NetworkProvider) {
    validateParams(params);
    const [a, b = params.allow[0], c = params.allow[0]] = params.allow;
    this.contract = new Contract(artifact, [
      categoryToVmBytes(params.stateCategory),
      params.agentPkh,
      params.ownerLock,
      a, b, c,
      params.limit,
      params.period,
      params.maxFee,
    ], { provider, contractType: 'p2sh32' });
  }

  get address(): string { return this.contract.address; }
  get tokenAddress(): string { return this.contract.tokenAddress; }

  /** All UTXOs on the contract, split into the (single) state UTXO and stray bare UTXOs. */
  async getUtxos(): Promise<{ state?: Utxo; stray: Utxo[]; invalid: Utxo[] }> {
    const all = await this.contract.getUtxos();
    const isState = (u: Utxo) => u.token?.category === this.params.stateCategory
      && u.token.nft?.capability === 'mutable' && u.token.amount === 0n;
    const states = all.filter(isState);
    return {
      state: states[0],
      // more than one state UTXO can only come from an owner mistake at genesis; surface it
      invalid: states.slice(1).concat(all.filter((u) => u.token && !isState(u))),
      stray: all.filter((u) => !u.token),
    };
  }

  static stateOf(utxo: Utxo): LeashState {
    const c = utxo.token?.nft?.commitment;
    if (c === undefined) throw new Error('UTXO has no NFT');
    return decodeState(c);
  }

  /** Build (not send) an agent payment. Throws locally when the contract would reject it. */
  buildPay(args: PayArgs): TransactionBuilder {
    if (args.fee === undefined) {
      // probe pass skips the limit check: the size does not depend on the fee or the state values
      let probe: string;
      try { probe = this.buildPayUnchecked(args, 1000n, true).build(); }
      catch (e: any) { throw new Error(`insufficient leash balance or bad payment: ${e?.message ?? e}`); }
      const fee = BigInt(probe.length / 2) + 5n;
      if (fee > this.params.maxFee) throw new Error(`required fee ${fee} > maxFee ${this.params.maxFee}`);
      return this.buildPay({ ...args, fee });
    }
    const fee = args.fee;
    if (fee > this.params.maxFee) throw new Error(`fee ${fee} > maxFee ${this.params.maxFee}`);
    const state = AgentLeash.stateOf(args.stateUtxo);
    nextState(state, args.elapsedAdd, args.amount + fee, this.params.period, this.params.limit); // throws LimitExceededError
    return this.buildPayUnchecked(args, fee);
  }

  private buildPayUnchecked(args: PayArgs, fee: bigint, probe = false): TransactionBuilder {
    const state = AgentLeash.stateOf(args.stateUtxo);
    let next: LeashState;
    try { next = nextState(state, args.elapsedAdd, args.amount + fee, this.params.period, this.params.limit); }
    catch (e) { if (!probe) throw e; next = { elapsed: 0n, spent: 0n }; } // size probe only
    const change = args.stateUtxo.satoshis - args.amount - fee;
    if (!probe && change < MIN_STATE_VALUE) throw new Error(`insufficient leash balance: change ${change} < ${MIN_STATE_VALUE}, top up`);
    const payTo = typeof args.payTo === 'string' ? lockingBytecodeOf(args.payTo) : args.payTo;
    const agentPub = secp256k1.derivePublicKeyCompressed(args.agentPrivateKey);
    if (typeof agentPub === 'string') throw new Error(agentPub);

    return new TransactionBuilder({ provider: this.provider })
      .addInput(args.stateUtxo, this.contract.unlock.pay(agentPub, new SignatureTemplate(args.agentPrivateKey), args.elapsedAdd),
        { sequence: Number(args.elapsedAdd) })
      .addOutput({
        to: this.contract.tokenAddress,
        amount: change,
        token: {
          category: this.params.stateCategory,
          amount: 0n,
          nft: { capability: 'mutable', commitment: encodeState(next) },
        },
      })
      .addOutput({ to: payTo, amount: args.amount })
      .addOutput({ to: receiptLockingBytecode(args.requestHash), amount: 0n });
  }

  /** Unlocker for any contract UTXO spent on the owner path; ownerInputIndex = index of the owner's P2PKH input. */
  ownerUnlocker(ownerInputIndex: number): Unlocker {
    return this.contract.unlock.owner(BigInt(ownerInputIndex));
  }

  /**
   * Withdraw everything (state UTXO + strays) to the owner. The NFT is burned (its output is
   * omitted) unless `keepNft` is set, in which case it is sent to `nftTo` (e.g. the owner's token address).
   * `ownerUtxo` + `ownerUnlocker` is the owner's own P2PKH input (SignatureTemplate.unlockP2PKH() or a
   * WizardConnect placeholder).
   */
  buildWithdraw(args: {
    contractUtxos: Utxo[]; ownerUtxo: Utxo; ownerUnlocker: Unlocker; ownerAddress: string;
    /** Token-aware owner address; required when stray token UTXOs (not the state NFT) are swept. */
    ownerTokenAddress?: string;
    fee?: bigint;
  }): TransactionBuilder {
    if (args.fee === undefined) return withAutoFee((f) => this.buildWithdraw({ ...args, fee: f }), 1, 5n, placeholderBytes([args.ownerUnlocker])).builder;
    const fee = args.fee;
    const isState = (u: Utxo) => u.token?.category === this.params.stateCategory && u.token.nft?.capability === 'mutable';
    // Jules review AL-06: stray tokens someone sent to the leash are forwarded to the owner, not burned.
    const strayTokens = args.contractUtxos.filter((u) => u.token && !isState(u));
    if (strayTokens.length && !args.ownerTokenAddress) throw new Error('stray token UTXOs present: pass ownerTokenAddress to forward them');
    const tb = new TransactionBuilder({ provider: this.provider });
    tb.addInput(args.ownerUtxo, args.ownerUnlocker);
    for (const u of args.contractUtxos) tb.addInput(u, this.ownerUnlocker(0));
    let total = args.ownerUtxo.satoshis + args.contractUtxos.reduce((s, u) => s + u.satoshis, 0n);
    for (const u of strayTokens) {
      tb.addOutput({ to: args.ownerTokenAddress!, amount: MIN_STATE_VALUE, token: u.token });
      total -= MIN_STATE_VALUE;
    }
    // the state NFT (if included) is burned: the leash ends here
    tb.addOutput({ to: args.ownerAddress, amount: total - fee });
    return tb;
  }

  /** Top up: owner adds sats to the state UTXO, state unchanged. */
  buildTopUp(args: {
    stateUtxo: Utxo; ownerUtxo: Utxo; ownerUnlocker: Unlocker; ownerAddress: string; amount: bigint; fee?: bigint;
  }): TransactionBuilder {
    if (args.fee === undefined) return withAutoFee((f) => this.buildTopUp({ ...args, fee: f }), 1, 5n, placeholderBytes([args.ownerUnlocker])).builder;
    const fee = args.fee;
    const change = args.ownerUtxo.satoshis - args.amount - fee;
    const outputs: Output[] = [{
      to: this.contract.tokenAddress,
      amount: args.stateUtxo.satoshis + args.amount,
      token: args.stateUtxo.token,
    }];
    if (change >= DUST) outputs.push({ to: args.ownerAddress, amount: change });
    return new TransactionBuilder({ provider: this.provider })
      .addInput(args.stateUtxo, this.ownerUnlocker(1))
      .addInput(args.ownerUtxo, args.ownerUnlocker)
      .addOutputs(outputs);
  }
}

/**
 * Genesis: the owner spends a UTXO with vout == 0 (its txid becomes the NFT category) and creates
 * exactly one mutable state NFT with state (0, 0) on the leash address, funded with `fund` sats.
 * Returns the leash (address now known) and an unsent TransactionBuilder.
 */
export function buildGenesis(args: {
  provider: NetworkProvider;
  ownerUtxo: Utxo;
  ownerUnlocker: Unlocker;
  ownerAddress: string;
  params: Omit<LeashParams, 'stateCategory'>;
  fund: bigint;
  fee?: bigint;
}): { leash: AgentLeash; builder: TransactionBuilder } {
  if (args.fee === undefined) {
    const { builder } = withAutoFee((f) => buildGenesis({ ...args, fee: f }).builder, 1, 5n, placeholderBytes([args.ownerUnlocker]));
    return { leash: buildGenesis({ ...args, fee: 0n }).leash, builder };
  }
  if (args.ownerUtxo.vout !== 0) throw new Error('genesis needs an owner UTXO with vout 0 (do a self-send first)');
  if (args.ownerUtxo.token) throw new Error('genesis input must not carry tokens');
  const fee = args.fee;
  const leash = new AgentLeash({ ...args.params, stateCategory: args.ownerUtxo.txid }, args.provider);
  const change = args.ownerUtxo.satoshis - args.fund - fee;
  if (args.fund < MIN_STATE_VALUE) throw new Error('fund below minimum state value');
  if (change < 0n) throw new Error('owner UTXO too small');
  const builder = new TransactionBuilder({ provider: args.provider })
    .addInput(args.ownerUtxo, args.ownerUnlocker)
    .addOutput({
      to: leash.tokenAddress,
      amount: args.fund,
      token: { category: args.ownerUtxo.txid, amount: 0n, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 0n, spent: 0n }) } },
    });
  if (change >= DUST) builder.addOutput({ to: args.ownerAddress, amount: change });
  return { leash, builder };
}
