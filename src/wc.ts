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
export function checkInputPaths(inputPaths: InputPath[], inputCount: number): void {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('inputPaths must name at least one wallet input');
  const seen = new Set<number>();
  for (const [i] of inputPaths) {
    if (!Number.isInteger(i) || i < 0 || i >= inputCount) throw new Error(`inputPath index ${i} out of range`);
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

/** Full consensus + standardness check of a signed transaction against its source outputs (BCH 2026 VM). */
export function verifySigned(txHex: string, relayedSourceOutputs: any[]): true | string {
  const tx = decodeTransaction(hexToBin(txHex));
  if (typeof tx === 'string') return tx;
  const sourceOutputs = hydrateSourceOutputs(relayedSourceOutputs).map(({ valueSatoshis, lockingBytecode, token }) => ({ valueSatoshis, lockingBytecode, ...(token && { token }) }));
  const r = createVirtualMachineBch2026(true).verify({ transaction: tx, sourceOutputs });
  return r === true ? true : (typeof r === 'string' ? r : JSON.stringify(r));
}
