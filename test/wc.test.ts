// Owner path through WizardConnect: dapp builds with placeholderP2PKHUnlocker -> relay JSON -> wallet signs
// its own input (0x61) -> full BCH 2026 VM verification of the signed transaction.
import { describe, expect, it } from 'vitest';
import { decodeTransaction, hexToBin } from '@bitauth/libauth';
import { placeholderP2PKHUnlocker } from 'cashscript';
import {
  buildGenesis, encodeState, P2PKH_UNLOCK_BYTES, signWizardRequest, toWizardSignRequest, verifySigned, type WizardSignPayload,
} from '../src/index.js';
import { setup } from './helpers.js';

/** What actually crosses the relay: plain JSON (relay-client does JSON.stringify). */
const overRelay = (p: WizardSignPayload): WizardSignPayload => JSON.parse(JSON.stringify(p));

const feeRate = (txHex: string, relayed: any[]) => {
  const tx = decodeTransaction(hexToBin(txHex));
  if (typeof tx === 'string') throw new Error(tx);
  const inSum = relayed.reduce((s, so) => s + BigInt(String(so.valueSatoshis).replace(/[^0-9]/g, '')), 0n);
  const outSum = tx.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  return Number(inSum - outSum) / (txHex.length / 2);
};

describe('WizardConnect owner path', () => {
  it('withdraw: wallet signs only its input, the signed tx passes the VM and pays >= 1 sat/byte', () => {
    const ctx = setup();
    const state = ctx.addState(40_000n, { elapsed: 3n, spent: 2_000n });
    const ownerUtxo = ctx.addP2pkh(ctx.owner, 5_000n);
    const tb = ctx.leash.buildWithdraw({
      contractUtxos: [state], ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(ctx.owner.address), ownerAddress: ctx.owner.address,
    });
    const req = overRelay(toWizardSignRequest(tb, { inputPaths: [[0, 'receive', 0]], userPrompt: 'Withdraw leash' }));
    const relayed = (req.transaction as any).sourceOutputs;
    // state NFT must survive the relay serialization, otherwise the SIGHASH_UTXOS digest is wrong
    expect(relayed[1].token.nft).toEqual({ capability: 'mutable', commitment: encodeState({ elapsed: 3n, spent: 2_000n }) });
    const signed = signWizardRequest(req, () => ctx.owner.priv);
    expect(verifySigned(signed, relayed)).toBe(true);
    expect(feeRate(signed, relayed)).toBeGreaterThanOrEqual(1);
  });

  it('top-up through WizardConnect verifies', () => {
    const ctx = setup();
    const state = ctx.addState(10_000n);
    const ownerUtxo = ctx.addP2pkh(ctx.owner, 50_000n);
    const tb = ctx.leash.buildTopUp({
      stateUtxo: state, ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(ctx.owner.address), ownerAddress: ctx.owner.address, amount: 20_000n,
    });
    const req = overRelay(toWizardSignRequest(tb, { inputPaths: [[1, 'receive', 0]] }));
    const signed = signWizardRequest(req, () => ctx.owner.priv);
    expect(verifySigned(signed, (req.transaction as any).sourceOutputs)).toBe(true);
    expect(feeRate(signed, (req.transaction as any).sourceOutputs)).toBeGreaterThanOrEqual(1);
  });

  it('genesis (CashTokens NFT creation) signed by the wallet verifies', () => {
    const ctx = setup();
    const ownerUtxo = { ...ctx.addP2pkh(ctx.owner, 100_000n), vout: 0 };
    const { builder } = buildGenesis({
      provider: ctx.provider, ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(ctx.owner.address), ownerAddress: ctx.owner.address,
      params: { agentPkh: ctx.agent.pkh, ownerLock: ctx.owner.lock, allow: [ctx.server.lock], limit: 6_000n, period: 3n, maxFee: 2_000n },
      fund: 40_000n,
    });
    const req = overRelay(toWizardSignRequest(builder, { inputPaths: [[0, 'receive', 0]] }));
    const signed = signWizardRequest(req, () => ctx.owner.priv);
    expect(verifySigned(signed, (req.transaction as any).sourceOutputs)).toBe(true);
    expect(feeRate(signed, (req.transaction as any).sourceOutputs)).toBeGreaterThanOrEqual(1);
  });

  it('fee accounts for the placeholder up front (CashScript refuses an underpaying placeholder tx)', () => {
    const ctx = setup();
    const state = ctx.addState(40_000n);
    const ownerUtxo = ctx.addP2pkh(ctx.owner, 5_000n);
    const args = { contractUtxos: [state], ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(ctx.owner.address), ownerAddress: ctx.owner.address };
    const auto = ctx.leash.buildWithdraw(args);
    const req = overRelay(toWizardSignRequest(auto, { inputPaths: [[0, 'receive', 0]] }));
    const signed = signWizardRequest(req, () => ctx.owner.priv);
    const size = signed.length / 2;
    const rate = feeRate(signed, (req.transaction as any).sourceOutputs);
    // exact: size + 5 sats margin, no retry overshoot
    expect(Math.round(rate * size)).toBe(size + 5);
    expect(size - auto.build().length / 2).toBe(P2PKH_UNLOCK_BYTES);
    // a fee measured on the unsigned bytes only is caught by CashScript before it reaches the wallet
    const naive = ctx.leash.buildWithdraw({ ...args, fee: BigInt(auto.build().length / 2) + 5n });
    expect(() => toWizardSignRequest(naive, { inputPaths: [[0, 'receive', 0]] })).toThrow(/lower than the standard minimum fee/);
  });

  it('a dapp that lies about the state NFT in sourceOutputs gets a signature the network rejects (SIGHASH_UTXOS)', () => {
    const ctx = setup();
    const state = ctx.addState(40_000n, { elapsed: 0n, spent: 0n });
    const ownerUtxo = ctx.addP2pkh(ctx.owner, 5_000n);
    const tb = ctx.leash.buildWithdraw({
      contractUtxos: [state], ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(ctx.owner.address), ownerAddress: ctx.owner.address,
    });
    const honest = overRelay(toWizardSignRequest(tb, { inputPaths: [[0, 'receive', 0]] }));
    const lie = overRelay(honest);
    (lie.transaction as any).sourceOutputs[1].token.nft.commitment = encodeState({ elapsed: 9n, spent: 9n });
    const signedOnLie = signWizardRequest(lie, () => ctx.owner.priv);
    expect(verifySigned(signedOnLie, (honest.transaction as any).sourceOutputs)).not.toBe(true);
  });

  it('reference signer refuses an inputPath that points at the contract input', () => {
    const ctx = setup();
    const state = ctx.addState(40_000n);
    const ownerUtxo = ctx.addP2pkh(ctx.owner, 5_000n);
    const tb = ctx.leash.buildWithdraw({
      contractUtxos: [state], ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(ctx.owner.address), ownerAddress: ctx.owner.address,
    });
    expect(() => toWizardSignRequest(tb, { inputPaths: [[1, 'receive', 0]] })).toThrow(/already unlocked/);
    const req = overRelay(toWizardSignRequest(tb, { inputPaths: [[0, 'receive', 0]] }));
    (req as any).inputPaths = [[1, 'receive', 0]];
    expect(() => signWizardRequest(req, () => ctx.owner.priv)).toThrow(/not locked to this wallet/);
  });

  it('a wrong wallet key cannot produce a valid owner signature', () => {
    const ctx = setup();
    const state = ctx.addState(40_000n);
    const ownerUtxo = ctx.addP2pkh(ctx.owner, 5_000n);
    const tb = ctx.leash.buildWithdraw({
      contractUtxos: [state], ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(ctx.owner.address), ownerAddress: ctx.owner.address,
    });
    const req = overRelay(toWizardSignRequest(tb, { inputPaths: [[0, 'receive', 0]] }));
    expect(() => signWizardRequest(req, () => ctx.attacker.priv)).toThrow(/not locked to this wallet/);
  });
});
