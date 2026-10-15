// "Try to break it" builders (src/attacks.ts): each attack breaks exactly one rule and the contract
// (CashScript debugger on MockNetworkProvider) refuses it with that rule. The clock attack is refused by
// consensus (BIP68) before the script runs; the mock does not model BIP68, so the test checks the tx shape.
import { describe, expect, it } from 'vitest';
import { decodeTransaction, hexToBin } from '@bitauth/libauth';
import { ATTACKS, buildAttack, decodeState, localReason, type AttackKind } from '../src/index.js';
import { LIMIT, PERIOD, setup } from './helpers.js';

describe('try-to-break-it attacks', () => {
  const scriptAttacks: AttackKind[] = ['recipient', 'overspend', 'fee', 'fakereset'];
  for (const kind of scriptAttacks) {
    it(`${kind}: the contract refuses with "${ATTACKS[kind].rule}"`, async () => {
      const ctx = setup();
      const state = ctx.addState(100_000n, { elapsed: 2n, spent: 3_000n });
      const a = buildAttack(kind, { leash: ctx.leash, stateUtxo: state, agentPrivateKey: ctx.agent.priv, realAge: 0n });
      expect(a.builder).toFailRequireWith(ATTACKS[kind].rule);
      expect(localReason(a.builder)).toBe(ATTACKS[kind].rule);
      await expect(a.builder.send()).rejects.toThrow();
    });
  }

  it('overspend lands exactly 1 sat over the limit when far from it, and above it when close', () => {
    const ctx = setup();
    const far = buildAttack('overspend', { leash: ctx.leash, stateUtxo: ctx.addState(100_000n, { elapsed: 0n, spent: 0n }), agentPrivateKey: ctx.agent.priv, realAge: 0n });
    expect(far.claimed.spent).toBe(LIMIT + 1n);
    const close = buildAttack('overspend', { leash: ctx.leash, stateUtxo: ctx.addState(100_000n, { elapsed: 0n, spent: LIMIT - 100n }), agentPrivateKey: ctx.agent.priv, realAge: 0n });
    expect(close.claimed.spent).toBeGreaterThan(LIMIT);
    expect(close.builder).toFailRequireWith('pay: limit exceeded');
  });

  it('clock: claims a full period on a coin that is younger; sequence carries the claim', () => {
    const ctx = setup();
    const state = ctx.addState(100_000n, { elapsed: 1n, spent: 3_000n });
    const a = buildAttack('clock', { leash: ctx.leash, stateUtxo: state, agentPrivateKey: ctx.agent.priv, realAge: 1n });
    const tx = decodeTransaction(hexToBin(a.builder.build()));
    if (typeof tx === 'string') throw new Error(tx);
    expect(tx.version).toBe(2);
    expect(tx.inputs[0].sequenceNumber).toBe(Number(PERIOD));
    expect(decodeState(Buffer.from(tx.outputs[0].token!.nft!.commitment).toString('hex'))).toEqual({ elapsed: 0n, spent: a.amount + a.fee });
    expect(() => buildAttack('clock', { leash: ctx.leash, stateUtxo: state, agentPrivateKey: ctx.agent.priv, realAge: PERIOD })).toThrow(/younger than one period/);
  });

  it('refuses to build when the balance cannot cover the attack (no misleading rejection reason)', () => {
    const ctx = setup();
    const state = ctx.addState(1_500n);
    expect(() => buildAttack('recipient', { leash: ctx.leash, stateUtxo: state, agentPrivateKey: ctx.agent.priv, realAge: 0n })).toThrow(/top up first/);
  });
});
