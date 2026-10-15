// "Try to break it": transactions a compromised agent could sign, each breaking exactly one rule of the
// covenant while everything else matches an honest payment. Used by the web demo (broadcast, show the node's
// verbatim refusal) and by scripts/chipnet.ts. Nothing here bypasses the network: these transactions are
// meant to be REJECTED. The SDK's own buildPay would refuse to build them, that is why they are built raw.
import { secp256k1, sha256 } from '@bitauth/libauth';
import { SignatureTemplate, TransactionBuilder, type SpendableUtxo as Utxo } from 'cashscript';
import { AgentLeash, DUST, MIN_STATE_VALUE, p2pkhLock, pkhOfPrivateKey } from './leash.js';
import { encodeState, type LeashState } from './state.js';
import { receiptLockingBytecode } from './receipt.js';

export const ATTACKS = {
  recipient: {
    title: 'Pay an address that is not allow-listed',
    story: 'The agent is tricked into paying an attacker (here: itself).',
    rule: 'pay: recipient not allow-listed',
  },
  overspend: {
    title: 'Spend 1 sat over the window limit',
    story: 'The agent ignores its budget and signs a payment that ends 1 sat above the limit.',
    rule: 'pay: limit exceeded',
  },
  fee: {
    title: 'Drain through the miner fee',
    story: 'The agent sets the fee 1 sat above maxFee, hoping to burn the balance as fees.',
    rule: 'pay: fee above maxFee',
  },
  fakereset: {
    title: 'Write a fresh window without waiting',
    story: 'The agent claims the window already reset and writes spent = this payment only.',
    rule: 'pay: wrong new state',
  },
  clock: {
    title: 'Fast-forward the clock',
    story: 'The agent claims the state coin is a full period old although it is not.',
    rule: 'consensus: non-BIP68-final (the network refuses the relative locktime before the script runs)',
  },
} as const;

export type AttackKind = keyof typeof ATTACKS;

export interface AttackArgs {
  leash: AgentLeash;
  stateUtxo: Utxo;
  agentPrivateKey: Uint8Array;
  /** Real proven age of the state UTXO in blocks (tip + 1 - height; 0 if unconfirmed). */
  realAge: bigint;
  /** Allow-listed payee used where the attack does not change the recipient. Default: first allow-list entry. */
  payee?: Uint8Array;
  /** Fee for the attack transaction (sats). Default 710, an honest pay is ~705. */
  fee?: bigint;
}

export interface Attack { kind: AttackKind; builder: TransactionBuilder; amount: bigint; fee: bigint; claimed: LeashState; elapsedAdd: bigint }

export function buildAttack(kind: AttackKind, a: AttackArgs): Attack {
  const { leash, stateUtxo } = a;
  const p = leash.params;
  const st = AgentLeash.stateOf(stateUtxo);
  let fee = a.fee ?? 710n;
  let amount = DUST;
  let payTo = a.payee ?? p.allow[0];
  let elapsedAdd = 0n;
  if (kind === 'recipient') payTo = p2pkhLock(pkhOfPrivateKey(a.agentPrivateKey));
  if (kind === 'fee') fee = p.maxFee + 1n;
  if (kind === 'overspend') {
    // the window of the honest next state (no claimed age): 1 sat more than what is left
    const left = p.limit - st.spent - fee;
    amount = left + 1n > DUST ? left + 1n : DUST;
    if (st.spent + amount + fee <= p.limit) throw new Error('overspend attack: state too far from the limit');
  }
  if (kind === 'clock') {
    if (a.realAge >= p.period) throw new Error('clock attack needs a state coin younger than one period (pay once, then try)');
    if (p.period > 65535n) throw new Error('period out of range');
    elapsedAdd = p.period; // more age than the coin really has
  }
  let claimed: LeashState = { elapsed: st.elapsed + elapsedAdd, spent: st.spent + amount + fee };
  if (claimed.elapsed >= p.period) claimed = { elapsed: 0n, spent: amount + fee };
  if (kind === 'fakereset') claimed = { elapsed: 0n, spent: amount + fee };
  const change = stateUtxo.satoshis - amount - fee;
  if (change < MIN_STATE_VALUE) throw new Error(`leash balance too low for this attack (needs ${amount + fee + MIN_STATE_VALUE} sats), top up first`);

  const agentPub = secp256k1.derivePublicKeyCompressed(a.agentPrivateKey);
  if (typeof agentPub === 'string') throw new Error(agentPub);
  const builder = new TransactionBuilder({ provider: leash.provider })
    .addInput(stateUtxo, leash.contract.unlock.pay(agentPub, new SignatureTemplate(a.agentPrivateKey), elapsedAdd), { sequence: Number(elapsedAdd) })
    .addOutput({
      to: leash.tokenAddress,
      amount: change,
      token: { category: p.stateCategory, amount: 0n, nft: { capability: 'mutable', commitment: encodeState(claimed) } },
    })
    .addOutput({ to: payTo, amount })
    .addOutput({ to: receiptLockingBytecode(sha256.hash(new TextEncoder().encode(`attack:${kind}`))), amount: 0n });
  return { kind, builder, amount, fee, claimed, elapsedAdd };
}

/** First failing `require` according to CashScript's local debugger, or '' if the script itself passes. */
export function localReason(builder: TransactionBuilder): string {
  try { builder.debug(); return ''; } catch (e: any) {
    const lines = String(e?.message ?? e).split('\n');
    const req = lines.find((l) => l.includes('require'));
    const m = req?.match(/"([^"]+)"/);
    return m ? m[1] : (req ?? lines[0]).trim();
  }
}
