// WizardConnect glue for the owner path (genesis, top-up, withdraw).
//
// The owner's wallet signs only its own P2PKH input; contract inputs on the owner path carry a
// complete unlocking bytecode (`owner(ownerInputIndex)` takes no signature), so the wallet never has
// to understand the covenant. Agent payments (`pay`) are signed by the agent key, not via WizardConnect.
//
// Wire format follows @wizardconnect/core docs/serialization.md: transaction as hex, source outputs
// through `sourceOutputToRelay` (hex strings + `<bigint: Xn>`), because the relay itself does a plain
// JSON.stringify and cannot carry BigInt or Uint8Array.
import {
  SigningSerializationFlag, binToHex, createVirtualMachineBch2026, decodeTransaction, encodeTransaction,
  generateSigningSerializationBCH, hash160, hash256, hexToBin, secp256k1,
  type Input, type Output as LibauthOutput, type Transaction,
} from '@bitauth/libauth';
import { toBigInt, toUint8Array } from '@wizardconnect/core';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import type { SignTransactionRequest } from '@wizardconnect/core';
import type { TransactionBuilder } from 'cashscript';
import { p2pkhLock } from './leash.js';

export { P2PKH_UNLOCK_BYTES, isPlaceholder, placeholderBytes } from './leash.js';

/** WizardConnect wallets MUST sign with exactly SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID (0x61). */
export const WC_SIGHASH = SigningSerializationFlag.allOutputs | SigningSerializationFlag.utxos | SigningSerializationFlag.forkId;

export type InputPath = [inputIndex: number, pathName: string, addressIndex: number];
export type WizardSignPayload = Pick<SignTransactionRequest, 'transaction' | 'inputPaths'>;

/**
 * Shape check shared by the dapp side and the reference signer: at least one path, every index an
 * integer inside the input list, no index named twice (Jules review 4474447409157392796). A duplicate
 * is harmless for our signer (same signature twice) but undefined for real wallets, and a fractional
 * index used to surface as a TypeError instead of a readable refusal.
 */
const WALLET_PATHS = new Set(['receive', 'change', 'defi']);
export function checkInputPaths(inputPaths: InputPath[], inputCount: number): void {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('inputPaths must name at least one wallet input');
  const seen = new Set<number>();
  for (const item of inputPaths) {
    if (!Array.isArray(item) || item.length !== 3) throw new Error('inputPath entry must be a 3-element tuple [inputIndex, pathName, addressIndex]');
    const [i, pathName, addressIndex] = item;
    if (!Number.isInteger(i) || Object.is(i, -0) || i < 0 || i >= inputCount) throw new Error(`inputPath index ${i} out of range`);
    // Well-known hdwalletv1 paths only (receive/change/defi); extension paths like stealth_scan never sign spends here.
    if (!WALLET_PATHS.has(pathName as string)) throw new Error(`unknown pathName ${String(pathName)} in inputPath`);
    if (!Number.isInteger(addressIndex) || Object.is(addressIndex, -0) || addressIndex < 0) throw new Error(`addressIndex ${addressIndex} must be a non-negative integer`);
    if (seen.has(i)) throw new Error(`duplicate input index ${i} in inputPaths`);
    seen.add(i);
  }
}

/**
 * Turn an unsigned CashScript TransactionBuilder (owner input added with `placeholderP2PKHUnlocker`)
 * into the payload of `DappConnectionManager.signTransaction(...)`, relay-safe.
 */
export function toWizardSignRequest(builder: TransactionBuilder, opts: {
  inputPaths: InputPath[]; userPrompt?: string; broadcast?: boolean;
}): WizardSignPayload {
  const wc = builder.generateWcTransactionObject({ broadcast: opts.broadcast ?? false, userPrompt: opts.userPrompt });
  const transaction = binToHex(encodeTransaction(wc.transaction as Transaction));
  const sourceOutputs = wc.sourceOutputs.map((so) => sourceOutputToRelay(so as never));
  checkInputPaths(opts.inputPaths, sourceOutputs.length);
  for (const [i] of opts.inputPaths) {
    if (sourceOutputs[i].unlockingBytecode !== '') throw new Error(`input ${i} is already unlocked; only placeholder inputs go to the wallet`);
  }
  return {
    transaction: { transaction, sourceOutputs, broadcast: opts.broadcast ?? false, userPrompt: opts.userPrompt } as never,
    inputPaths: opts.inputPaths,
  };
}

/** Relay JSON -> libauth source outputs (inverse of sourceOutputToRelay). */
export function hydrateSourceOutputs(relayed: any[]): (Input & LibauthOutput)[] {
  return relayed.map((so) => ({
    outpointTransactionHash: toUint8Array(so.outpointTransactionHash),
    outpointIndex: so.outpointIndex,
    sequenceNumber: so.sequenceNumber,
    unlockingBytecode: toUint8Array(so.unlockingBytecode ?? ''),
    valueSatoshis: toBigInt(so.valueSatoshis),
    lockingBytecode: toUint8Array(so.lockingBytecode),
    ...(so.token && {
      token: {
        category: toUint8Array(so.token.category),
        amount: toBigInt(so.token.amount),
        ...(so.token.nft && {
          nft: {
            capability: so.token.nft.capability ?? 'none',
            commitment: toUint8Array(so.token.nft.commitment ?? ''),
          },
        }),
      },
    }),
  }));
}

/**
 * Reference wallet-side signer for tests and headless demos (NOT a wallet): signs exactly the inputs
 * named in `inputPaths` as P2PKH with 0x61, refuses anything else, leaves contract inputs untouched.
 * `keyFor` maps a path to a private key. Mirrors what Paytaca's WizardConnect signer does for P2PKH inputs.
 */
export function signWizardRequest(req: WizardSignPayload, keyFor: (pathName: string, addressIndex: number) => Uint8Array): string {
  const t = req.transaction as unknown as { transaction: string; sourceOutputs: any[] };
  const decoded = decodeTransaction(hexToBin(t.transaction));
  if (typeof decoded === 'string') throw new Error(`bad transaction: ${decoded}`);
  const sourceOutputs = hydrateSourceOutputs(t.sourceOutputs);
  if (sourceOutputs.length !== decoded.inputs.length) throw new Error('sourceOutputs must match inputs one to one');
  const tx: Transaction = { ...decoded, inputs: decoded.inputs.map((i) => ({ ...i })) };
  checkInputPaths(req.inputPaths as InputPath[], decoded.inputs.length);
  for (const [index, pathName, addressIndex] of req.inputPaths) {
    const priv = keyFor(pathName, addressIndex);
    const pub = secp256k1.derivePublicKeyCompressed(priv);
    if (typeof pub === 'string') throw new Error(pub);
    const so = sourceOutputs[index];
    if (!so) throw new Error(`no source output for input ${index}`);
    if (binToHex(so.lockingBytecode) !== binToHex(p2pkhLock(hash160(pub)))) {
      throw new Error(`input ${index} is not locked to this wallet's ${pathName}/${addressIndex} key`);
    }
    const preimage = generateSigningSerializationBCH(
      { inputIndex: index, sourceOutputs, transaction: tx },
      { coveredBytecode: so.lockingBytecode, signingSerializationType: Uint8Array.of(WC_SIGHASH) },
    );
    const sig = secp256k1.signMessageHashSchnorr(priv, hash256(preimage));
    if (typeof sig === 'string') throw new Error(sig);
    tx.inputs[index].unlockingBytecode = Uint8Array.from([0x41, ...sig, WC_SIGHASH, 0x21, ...pub]);
  }
  return binToHex(encodeTransaction(tx));
}

/**
 * Full consensus + standardness check of a signed transaction against its source outputs (BCH 2026 VM).
 * If `expectedTxHex` is provided, also verifies that the signed transaction matches the requested
 * transaction's inputs, outputs, locktime, and version (ensuring a wallet did not alter outputs/inputs).
 */
export function verifySigned(txHex: string, relayedSourceOutputs: any[], expectedTxHex?: string): true | string {
  const tx = decodeTransaction(hexToBin(txHex));
  if (typeof tx === 'string') return tx;

  if (expectedTxHex) {
    const expectedTx = decodeTransaction(hexToBin(expectedTxHex));
    if (typeof expectedTx === 'string') return `bad expected transaction: ${expectedTx}`;
    if (tx.version !== expectedTx.version) return 'signed transaction version does not match requested transaction';
    if (tx.locktime !== expectedTx.locktime) return 'signed transaction locktime does not match requested transaction';
    if (tx.inputs.length !== expectedTx.inputs.length) return 'signed transaction input count does not match requested transaction';
    for (let i = 0; i < tx.inputs.length; i++) {
      if (binToHex(tx.inputs[i].outpointTransactionHash) !== binToHex(expectedTx.inputs[i].outpointTransactionHash)
          || tx.inputs[i].outpointIndex !== expectedTx.inputs[i].outpointIndex
          || tx.inputs[i].sequenceNumber !== expectedTx.inputs[i].sequenceNumber) {
        return `signed transaction input ${i} outpoint or sequence does not match requested transaction`;
      }
    }
    if (tx.outputs.length !== expectedTx.outputs.length) return 'signed transaction output count does not match requested transaction';
    for (let i = 0; i < tx.outputs.length; i++) {
      const out = tx.outputs[i];
      const exp = expectedTx.outputs[i];
      if (out.valueSatoshis !== exp.valueSatoshis || binToHex(out.lockingBytecode) !== binToHex(exp.lockingBytecode)) {
        return `signed transaction output ${i} value or locking bytecode does not match requested transaction`;
      }
      const outToken = out.token ? JSON.stringify({ category: binToHex(out.token.category), amount: out.token.amount.toString(), nft: out.token.nft ? { capability: out.token.nft.capability, commitment: binToHex(out.token.nft.commitment) } : undefined }) : undefined;
      const expToken = exp.token ? JSON.stringify({ category: binToHex(exp.token.category), amount: exp.token.amount.toString(), nft: exp.token.nft ? { capability: exp.token.nft.capability, commitment: binToHex(exp.token.nft.commitment) } : undefined }) : undefined;
      if (outToken !== expToken) {
        return `signed transaction output ${i} token data does not match requested transaction`;
      }
    }
  }

  const sourceOutputs = hydrateSourceOutputs(relayedSourceOutputs).map(({ valueSatoshis, lockingBytecode, token }) => ({ valueSatoshis, lockingBytecode, ...(token && { token }) }));
  const r = createVirtualMachineBch2026(true).verify({ transaction: tx, sourceOutputs });
  return r === true ? true : (typeof r === 'string' ? r : JSON.stringify(r));
}
