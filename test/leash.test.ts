import { describe, it, expect } from 'vitest';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { randomUtxo, TransactionBuilder } from 'cashscript';
import { AgentLeash, buildGenesis, decodeState, encodeState, parseReceipt, receiptLockingBytecode, computeRequestHash, LimitExceededError } from '../src/index.js';
import { setup, rawPay, stateOut, receiptOut, mkKey, H, LIMIT, PERIOD, MAX_FEE, randomCategory } from './helpers.js';

const pay = (ctx: ReturnType<typeof setup>, stateUtxo: any, amount: bigint, elapsedAdd = 0n, payTo = ctx.server.address) =>
  ctx.leash.buildPay({ stateUtxo, agentPrivateKey: ctx.agent.priv, payTo, amount, requestHash: H(1), elapsedAdd });

/** Miner fee of a pay: what left the contract minus the payment. */
const feeOf = (before: { satoshis: bigint }, after: { satoshis: bigint }, amount: bigint) => before.satoshis - after.satoshis - amount;

/** Finds the leash's current state UTXO in the mock UTXO set. */
const current = async (ctx: ReturnType<typeof setup>) => (await ctx.leash.getUtxos()).state!;

describe('state encoding', () => {
  it('round-trips and matches toPaddedBytes layout', () => {
    const s = { elapsed: 3n, spent: 900n };
    expect(encodeState(s)).toBe('0300000000000000' + '8403000000000000');
    expect(decodeState(encodeState(s))).toEqual(s);
  });
  it('receipt format', () => {
    const b = receiptLockingBytecode(H(9));
    expect(b.length).toBe(39);
    expect(binToHex(b.slice(0, 7))).toBe('6a044c53483120');
    expect(parseReceipt(b)).toBe(H(9));
    expect(parseReceipt(b.slice(0, 38))).toBeUndefined();
  });
  it('request hash is length-prefixed (no field-split collisions)', () => {
    const a = computeRequestHash({ challengeNonce: '00'.repeat(16), method: 'GET', url: 'https://x/ab', body: '' });
    const b = computeRequestHash({ challengeNonce: '00'.repeat(16), method: 'GETh', url: 'ttps://x/ab', body: '' });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pay: happy path', () => {
  it('pays an allow-listed recipient and updates the state NFT', async () => {
    const ctx = setup();
    const u = ctx.addState();
    const tx = await pay(ctx, u, 3_000n).send();
    expect(tx.txid).toMatch(/^[0-9a-f]{64}$/);
    const s = await current(ctx);
    const fee = feeOf(u, s, 3_000n);
    expect(fee).toBeGreaterThan(600n); // ~700-byte tx at 1 sat/byte
    expect(fee).toBeLessThanOrEqual(MAX_FEE);
    // the limit counts everything that left the contract: payment + fee
    expect(AgentLeash.stateOf(s)).toEqual({ elapsed: 0n, spent: 3_000n + fee });
    const srv = await ctx.provider.getUtxos(ctx.server.address);
    expect(srv.map((x) => x.satoshis)).toContain(3_000n);
  });

  it('second allow-list slot works, unused third slot duplicates the first', async () => {
    const ctx = setup();
    const u = ctx.addState();
    await pay(ctx, u, 1_000n, 0n, ctx.server2.address).send();
    const s = await current(ctx);
    expect(AgentLeash.stateOf(s).spent).toBe(1_000n + feeOf(u, s, 1_000n));
  });

  it('series of payments up to exactly the limit, then one more sat-worth fails', async () => {
    const ctx = setup();
    ctx.addState();
    const fee = 750n;
    const payF = async (a: bigint) => ctx.leash.buildPay({ stateUtxo: await current(ctx), agentPrivateKey: ctx.agent.priv, payTo: ctx.server.address, amount: a, requestHash: H(1), elapsedAdd: 0n, fee }).send();
    await payF(3_000n); await payF(3_000n);
    await payF(LIMIT - 2n * (3_000n + fee) - fee); // lands exactly on the limit
    const s = await current(ctx);
    expect(AgentLeash.stateOf(s)).toEqual({ elapsed: 0n, spent: LIMIT });
    // SDK refuses locally with a human-readable error...
    expect(() => pay(ctx, s, 546n)).toThrow(LimitExceededError);
    // ...and the contract refuses the raw transaction
    const tb = rawPay(ctx, { input: s, outputs: [stateOut(ctx, s.satoshis - 546n - 1_000n, { elapsed: 0n, spent: LIMIT + 546n }), { to: ctx.server.address, amount: 546n }, receiptOut()] });
    expect(tb).toFailRequireWith('pay: limit exceeded');
  });

  it('window resets once proven age reaches the period', async () => {
    const ctx = setup();
    ctx.addState(100_000n, { elapsed: 4n, spent: LIMIT });
    // 6 more blocks -> elapsed 10 >= period 10 -> reset to (0, amount)
    const u = await current(ctx);
    await pay(ctx, u, 5_000n, PERIOD - 4n).send();
    const s = await current(ctx);
    expect(AgentLeash.stateOf(s)).toEqual({ elapsed: 0n, spent: 5_000n + feeOf(u, s, 5_000n) });
  });

  it('elapsed accumulates below the period without resetting', async () => {
    const ctx = setup();
    ctx.addState();
    const u0 = await current(ctx);
    await pay(ctx, u0, 1_000n, 3n).send();
    await pay(ctx, await current(ctx), 1_000n, 3n).send();
    const s = await current(ctx);
    expect(AgentLeash.stateOf(s)).toEqual({ elapsed: 6n, spent: u0.satoshis - s.satoshis });
  });

  it('elapsedAdd = 0 (unconfirmed chain) keeps the clock still', async () => {
    const ctx = setup();
    ctx.addState(100_000n, { elapsed: 9n, spent: 0n });
    const u = await current(ctx);
    await pay(ctx, u, 1_000n, 0n).send();
    const s = await current(ctx);
    expect(AgentLeash.stateOf(s)).toEqual({ elapsed: 9n, spent: 1_000n + feeOf(u, s, 1_000n) });
  });

  it('agent cannot reset the window early by writing a reset state itself', () => {
    const ctx = setup();
    const u = ctx.addState(100_000n, { elapsed: 9n, spent: LIMIT });
    // claims a reset with elapsedAdd 0
    const tb = rawPay(ctx, { input: u, outputs: [stateOut(ctx, u.satoshis - 2_000n - 1_000n, { elapsed: 0n, spent: 2_000n }), { to: ctx.server.address, amount: 2_000n }, receiptOut()] });
    expect(tb).toFailRequireWith('pay: limit exceeded');
  });
});

describe('pay: attacks (each must fail in the contract)', () => {
  const base = (ctx: ReturnType<typeof setup>, u: any, amount = 1_000n, fee = 1_000n) => ({
    s: stateOut(ctx, u.satoshis - amount - fee, { elapsed: 0n, spent: amount + fee }),
    p: { to: ctx.server.address, amount },
    r: receiptOut(),
  });

  it('recipient not in allow-list', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    expect(rawPay(ctx, { input: u, outputs: [o.s, { to: ctx.attacker.address, amount: 1_000n }, o.r] })).toFailRequireWith('pay: recipient not allow-listed');
  });
  it('payment to the agent itself', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    expect(rawPay(ctx, { input: u, outputs: [o.s, { to: ctx.agent.address, amount: 1_000n }, o.r] })).toFailRequireWith('pay: recipient not allow-listed');
  });
  it('single payment above the limit', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u, LIMIT + 1n);
    expect(rawPay(ctx, { input: u, outputs: [o.s, o.p, o.r] })).toFailRequireWith('pay: limit exceeded');
  });
  it('dust payment (below 546 even where relay dust is lower)', () => {
    // a 1-byte recipient script has a relay dust threshold of ~474 sats; the contract still enforces 546.
    // The SDK refuses such an allow entry since 16.10 (validateParams), so the leash is deployed unchecked here.
    const short = Uint8Array.of(0x51);
    const ctx = setup({ allow: [short] }, { unchecked: true }); const u = ctx.addState(); const o = base(ctx, u, 500n);
    expect(rawPay(ctx, { input: u, outputs: [o.s, { to: short, amount: 500n }, o.r] })).toFailRequireWith('pay: payment below dust');
  });
  it('drain via miner fee', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u, 1_000n, MAX_FEE + 1n);
    expect(rawPay(ctx, { input: u, outputs: [o.s, o.p, o.r] })).toFailRequireWith('pay: fee above maxFee');
  });
  it('fee burn: fees count against the limit (many tiny payments with max fee)', () => {
    const ctx = setup(); const u = ctx.addState(100_000n, { elapsed: 0n, spent: LIMIT - 2_000n });
    // 546 sats payment + 1_500 fee = 2_046 > remaining 2_000; agent under-reports by counting only the payment
    const tb = rawPay(ctx, { input: u, outputs: [stateOut(ctx, u.satoshis - 546n - 1_500n, { elapsed: 0n, spent: LIMIT - 2_000n + 546n }), { to: ctx.server.address, amount: 546n }, receiptOut()] });
    expect(tb).toFailRequireWith('pay: limit exceeded');
  });
  it('fee exactly maxFee is fine', async () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u, 1_000n, MAX_FEE);
    await expect(rawPay(ctx, { input: u, outputs: [o.s, o.p, o.r] }).send()).resolves.toBeTruthy();
  });
  it('state output not to the contract (NFT + change to agent)', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    const s = { ...o.s, to: ctx.agent.tokenAddress };
    expect(rawPay(ctx, { input: u, outputs: [s, o.p, o.r] })).toFailRequireWith('pay: change must return to contract');
  });
  it('state NFT dropped (burned) on output 0', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    const s = { to: ctx.leash.address, amount: o.s.amount };
    expect(rawPay(ctx, { input: u, outputs: [s, o.p, o.r] })).toFailRequireWith('pay: state NFT must return');
  });
  it('state output below 1000 sats', () => {
    const ctx = setup(); const u = ctx.addState(2_900n); const o = base(ctx, u, 1_000n, 1_000n);
    expect(rawPay(ctx, { input: u, outputs: [o.s, o.p, o.r] })).toFailRequireWith('pay: state output below 1000 sats, top up');
  });
  it('foreign category: agent mints its own mutable NFT with spent=0 on the contract address', () => {
    const ctx = setup();
    const fake = randomCategory();
    const u = ctx.addState(100_000n, undefined, { category: fake, amount: 0n, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 0n, spent: 0n }) } });
    const tb = rawPay(ctx, { input: u, outputs: [stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 1_000n }, fake), { to: ctx.server.address, amount: 1_000n }, receiptOut()] });
    expect(tb).toFailRequireWith('pay: input lacks state NFT');
  });
  for (const cap of ['none', 'minting'] as const) {
    it(`state category with capability ${cap} is rejected`, () => {
      const ctx = setup();
      const u = ctx.addState(100_000n, undefined, { category: ctx.params.stateCategory, amount: 0n, nft: { capability: cap, commitment: encodeState({ elapsed: 0n, spent: 0n }) } });
      const tb = rawPay(ctx, { input: u, outputs: [stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 1_000n }, undefined, cap), { to: ctx.server.address, amount: 1_000n }, receiptOut()] });
      expect(tb).toFailRequireWith('pay: input lacks state NFT');
    });
  }
  it('state input carrying fungible tokens', () => {
    const ctx = setup();
    const u = ctx.addState(100_000n, undefined, { category: ctx.params.stateCategory, amount: 5n, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 0n, spent: 0n }) } });
    const s = stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 1_000n });
    s.token!.amount = 5n;
    expect(rawPay(ctx, { input: u, outputs: [s, { to: ctx.server.address, amount: 1_000n }, receiptOut()] })).toFailRequireWith('pay: input carries fungible tokens');
  });
  it('fourth output (extra payment to attacker)', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u, 1_000n, 2_000n);
    expect(rawPay(ctx, { input: u, outputs: [o.s, o.p, o.r, { to: ctx.attacker.address, amount: 1_000n }] })).toFailRequireWith('pay: exactly three outputs');
  });
  it('two outputs (no receipt)', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    expect(rawPay(ctx, { input: u, outputs: [o.s, o.p] })).toFailRequireWith('pay: exactly three outputs');
  });
  it('two inputs in pay (state + a stray UTXO on the contract)', () => {
    const ctx = setup(); const u = ctx.addState();
    const stray = ctx.provider.addUtxo(ctx.leash.address, randomUtxo({ satoshis: 20_000n })) as any;
    const o = base(ctx, u, 1_000n, 1_900n);
    expect(rawPay(ctx, { input: u, extraInputs: [stray], outputs: [{ ...o.s, amount: o.s.amount + 20_000n }, o.p, o.r] })).toFailRequireWith('pay: exactly one input');
  });
  it('stray bare UTXO on the contract cannot be spent by the agent', () => {
    const ctx = setup();
    const stray = ctx.provider.addUtxo(ctx.leash.address, randomUtxo({ satoshis: 20_000n })) as any;
    expect(rawPay(ctx, { input: stray, outputs: [{ to: ctx.leash.address, amount: 18_000n }, { to: ctx.server.address, amount: 1_000n }, receiptOut()] })).toFailRequireWith('pay: input lacks state NFT');
  });
  it('receipt with wrong length', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    const bad = receiptLockingBytecode(H(1)).slice(0, 38);
    expect(rawPay(ctx, { input: u, outputs: [o.s, o.p, { to: bad, amount: 0n }] })).toFailRequireWith('pay: bad receipt length');
  });
  it('receipt with wrong prefix (not LSH1)', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    const bad = receiptLockingBytecode(H(1)); bad[3] = 0x58; // "LXH1"
    expect(rawPay(ctx, { input: u, outputs: [o.s, o.p, { to: bad, amount: 0n }] })).toFailRequireWith('pay: bad receipt prefix');
  });
  it('receipt slot used as a second payment (P2PKH-like 39-byte script is not OP_RETURN)', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u, 1_000n, 2_000n);
    const bad = receiptLockingBytecode(H(1)); bad[0] = 0x51; // OP_1 instead of OP_RETURN -> anyone-can-spend-ish
    expect(rawPay(ctx, { input: u, outputs: [o.s, o.p, { to: bad, amount: 1_000n }] })).toFailRequireWith('pay: bad receipt prefix');
  });
  it('elapsedAdd larger than the proven age (sequence)', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    expect(rawPay(ctx, { input: u, elapsedAdd: 5n, sequence: 4, outputs: [{ ...o.s, token: { ...o.s.token!, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 5n, spent: 1_000n }) } } }, o.p, o.r] }))
      .toFailRequireWith('pay: elapsedAdd exceeds proven UTXO age');
  });
  it('CSV masking attack: elapsedAdd = 65536 with sequence 0 (bits above 16 are ignored by CSV)', () => {
    const ctx = setup(); const u = ctx.addState(100_000n, { elapsed: 0n, spent: LIMIT }); const o = base(ctx, u);
    expect(rawPay(ctx, { input: u, elapsedAdd: 65536n, sequence: 0, outputs: [o.s, o.p, o.r] })).toFailRequireWith('pay: elapsedAdd out of range');
  });
  it('CSV type-flag attack: elapsedAdd with bit 22 (time-based units) set', () => {
    const ctx = setup(); const u = ctx.addState(100_000n, { elapsed: 0n, spent: LIMIT }); const o = base(ctx, u);
    const v = (1n << 22n) | 1n;
    expect(rawPay(ctx, { input: u, elapsedAdd: v, sequence: Number(v), outputs: [o.s, o.p, o.r] })).toFailRequireWith('pay: elapsedAdd out of range');
  });
  it('negative elapsedAdd', () => {
    const ctx = setup(); const u = ctx.addState(100_000n, { elapsed: 5n, spent: 0n }); const o = base(ctx, u);
    expect(rawPay(ctx, { input: u, elapsedAdd: -5n, sequence: 0, outputs: [{ ...o.s, token: { ...o.s.token!, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 0n, spent: 1_000n }) } } }, o.p, o.r] }))
      .toFailRequireWith('pay: negative elapsedAdd');
  });
  it('wrong new state (agent under-reports spent)', () => {
    const ctx = setup(); const u = ctx.addState(100_000n, { elapsed: 0n, spent: 5_000n });
    const tb = rawPay(ctx, { input: u, outputs: [stateOut(ctx, u.satoshis - 2_000n, { elapsed: 0n, spent: 1_000n }), { to: ctx.server.address, amount: 1_000n }, receiptOut()] });
    expect(tb).toFailRequireWith('pay: wrong new state');
  });
  it('signer is not the agent (griefing)', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    expect(rawPay(ctx, { input: u, signer: ctx.attacker, outputs: [o.s, o.p, o.r] })).toFailRequireWith('not the agent key');
  });
  it('agent pubkey with a signature from another key', () => {
    const ctx = setup(); const u = ctx.addState(); const o = base(ctx, u);
    expect(rawPay(ctx, { input: u, signer: ctx.attacker, claimedPub: ctx.agent.pub, outputs: [o.s, o.p, o.r] })).toFailRequireWith(/bad agent signature|NULLFAIL|signature/i);
  });
  it('agent cannot use owner() with its own P2PKH input', () => {
    const ctx = setup(); const u = ctx.addState();
    const mine = ctx.addP2pkh(ctx.agent);
    const tb = new TransactionBuilder({ provider: ctx.provider })
      .addInput(u, ctx.leash.ownerUnlocker(1))
      .addInput(mine, ctx.agent.sig.unlockP2PKH())
      .addOutput({ to: ctx.agent.address, amount: u.satoshis + mine.satoshis - 2_000n });
    expect(tb).toFailRequireWith('owner: no owner input');
  });
  it('owner() pointing at the contract input itself fails', () => {
    const ctx = setup(); const u = ctx.addState();
    const tb = new TransactionBuilder({ provider: ctx.provider })
      .addInput(u, ctx.leash.ownerUnlocker(0))
      .addOutput({ to: ctx.agent.address, amount: u.satoshis - 2_000n });
    expect(tb).toFailRequireWith('owner: no owner input');
  });
});

describe('owner path', () => {
  it('withdraws everything (state + strays) with one owner input; NFT burned', async () => {
    const ctx = setup(); ctx.addState(80_000n);
    ctx.provider.addUtxo(ctx.leash.address, randomUtxo({ satoshis: 15_000n }));
    const own = ctx.addP2pkh(ctx.owner, 10_000n);
    const { state, stray } = await ctx.leash.getUtxos();
    await ctx.leash.buildWithdraw({ contractUtxos: [state!, ...stray], ownerUtxo: own, ownerUnlocker: ctx.owner.sig.unlockP2PKH(), ownerAddress: ctx.owner.address }).send();
    expect(await ctx.leash.contract.getUtxos()).toHaveLength(0);
    const got = (await ctx.provider.getUtxos(ctx.owner.address)).reduce((s, x) => s + x.satoshis, 0n);
    expect(80_000n + 15_000n + 10_000n - got).toBeLessThan(2_000n);
  });

  it('withdraw forwards stray tokens to the owner instead of burning them (Jules AL-06)', async () => {
    const ctx = setup(); ctx.addState(30_000n);
    const cat = randomCategory();
    ctx.provider.addUtxo(ctx.leash.tokenAddress, { ...randomUtxo({ satoshis: 2_000n }), token: { category: cat, amount: 77n } });
    const own = ctx.addP2pkh(ctx.owner, 10_000n);
    const { state, invalid } = await ctx.leash.getUtxos();
    expect(invalid).toHaveLength(1);
    const base = { contractUtxos: [state!, ...invalid], ownerUtxo: own, ownerUnlocker: ctx.owner.sig.unlockP2PKH(), ownerAddress: ctx.owner.address };
    expect(() => ctx.leash.buildWithdraw(base)).toThrow(/ownerTokenAddress/);
    await ctx.leash.buildWithdraw({ ...base, ownerTokenAddress: ctx.owner.tokenAddress }).send();
    const got = await ctx.provider.getUtxos(ctx.owner.tokenAddress);
    expect(got.find((u) => u.token?.category === cat)?.token?.amount).toBe(77n);
    expect(await ctx.leash.contract.getUtxos()).toHaveLength(0);
  });

  it('auto-fee re-measures when the change output appears only at the final fee (Jules AL-04)', async () => {
    const ctx = setup(); ctx.addState(5_000n);
    // probe fee 2000 leaves change below dust (no change output); the real fee (~400) leaves change above it
    const own = ctx.addP2pkh(ctx.owner, 2_000n + 1_000n + 300n);
    const tb = ctx.leash.buildTopUp({ stateUtxo: await current(ctx), ownerUtxo: own, ownerUnlocker: ctx.owner.sig.unlockP2PKH(), ownerAddress: ctx.owner.address, amount: 2_000n });
    await expect(tb.send()).resolves.toBeTruthy();
    expect((await current(ctx)).satoshis).toBe(7_000n);
  });

  it('tops up the state UTXO without touching the state', async () => {
    const ctx = setup(); ctx.addState(5_000n, { elapsed: 2n, spent: 700n });
    const own = ctx.addP2pkh(ctx.owner, 50_000n);
    await ctx.leash.buildTopUp({ stateUtxo: await current(ctx), ownerUtxo: own, ownerUnlocker: ctx.owner.sig.unlockP2PKH(), ownerAddress: ctx.owner.address, amount: 30_000n }).send();
    const s = await current(ctx);
    expect(s.satoshis).toBe(35_000n);
    expect(AgentLeash.stateOf(s)).toEqual({ elapsed: 2n, spent: 700n });
  });

  it('owner can reset the counter and migrate to new rules (new address, same NFT)', async () => {
    const ctx = setup(); ctx.addState(60_000n, { elapsed: 3n, spent: LIMIT });
    const own = ctx.addP2pkh(ctx.owner, 5_000n);
    const next = new AgentLeash({ ...ctx.params, limit: 20_000n, allow: [ctx.server.lock] }, ctx.provider);
    expect(next.address).not.toBe(ctx.leash.address);
    const s0 = await current(ctx);
    await new TransactionBuilder({ provider: ctx.provider })
      .addInput(s0, ctx.leash.ownerUnlocker(1))
      .addInput(own, ctx.owner.sig.unlockP2PKH())
      .addOutput({ to: next.tokenAddress, amount: 63_000n, token: { category: ctx.params.stateCategory, amount: 0n, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 0n, spent: 0n }) } } })
      .send();
    const s1 = (await next.getUtxos()).state!;
    await next.buildPay({ stateUtxo: s1, agentPrivateKey: ctx.agent.priv, payTo: ctx.server.address, amount: 15_000n, requestHash: H(2), elapsedAdd: 0n }).send();
    const s2 = (await next.getUtxos()).state!;
    expect(AgentLeash.stateOf(s2).spent).toBe(15_000n + feeOf(s1, s2, 15_000n));
  });
});

describe('genesis', () => {
  it('creates exactly one mutable state NFT at the leash address and the agent can pay', async () => {
    const ctx = setup();
    const ownerUtxo = { ...ctx.addP2pkh(ctx.owner, 200_000n) };
    expect(ownerUtxo.vout).toBeGreaterThanOrEqual(0);
    const genesisUtxo = ctx.provider.addUtxo(ctx.owner.address, { ...randomUtxo({ satoshis: 200_000n }), vout: 0 }) as any;
    const { leash, builder } = buildGenesis({
      provider: ctx.provider, ownerUtxo: genesisUtxo, ownerUnlocker: ctx.owner.sig.unlockP2PKH(), ownerAddress: ctx.owner.address,
      params: { agentPkh: ctx.agent.pkh, ownerLock: ctx.owner.lock, allow: [ctx.server.lock], limit: LIMIT, period: PERIOD, maxFee: MAX_FEE },
      fund: 50_000n,
    });
    await builder.send();
    const { state, invalid } = await leash.getUtxos();
    expect(invalid).toHaveLength(0);
    expect(state!.token!.category).toBe(genesisUtxo.txid);
    expect(AgentLeash.stateOf(state!)).toEqual({ elapsed: 0n, spent: 0n });
    await leash.buildPay({ stateUtxo: state!, agentPrivateKey: ctx.agent.priv, payTo: ctx.server.address, amount: 2_000n, requestHash: H(3), elapsedAdd: 0n }).send();
  });

  it('refuses a genesis input with vout != 0', () => {
    const ctx = setup();
    const u = ctx.provider.addUtxo(ctx.owner.address, { ...randomUtxo({ satoshis: 100_000n }), vout: 1 }) as any;
    expect(() => buildGenesis({ provider: ctx.provider, ownerUtxo: u, ownerUnlocker: ctx.owner.sig.unlockP2PKH(), ownerAddress: ctx.owner.address,
      params: { agentPkh: ctx.agent.pkh, ownerLock: ctx.owner.lock, allow: [ctx.server.lock], limit: LIMIT, period: PERIOD, maxFee: MAX_FEE }, fund: 10_000n })).toThrow(/vout 0/);
  });

  it('category byte order: a leash built with the display-order category bytes cannot pay', () => {
    const ctx = setup();
    const u = ctx.addState();
    // leash whose constructor got the category NOT reversed
    const wrong = new AgentLeash({ ...ctx.params, stateCategory: binToHex(hexToBin(ctx.params.stateCategory).reverse()) }, ctx.provider);
    const u2 = ctx.provider.addUtxo(wrong.tokenAddress, { ...randomUtxo({ satoshis: 100_000n }), token: u.token }) as any;
    const tb = new TransactionBuilder({ provider: ctx.provider })
      .addInput(u2, wrong.contract.unlock.pay(ctx.agent.pub, ctx.agent.sig, 0n), { sequence: 0 })
      .addOutput({ to: wrong.tokenAddress, amount: 98_000n, token: { ...u.token!, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 0n, spent: 1_000n }) } } })
      .addOutput({ to: ctx.server.address, amount: 1_000n })
      .addOutput(receiptOut());
    expect(tb).toFailRequireWith('pay: input lacks state NFT');
  });
});

describe('SDK guards', () => {
  it('rejects fee above maxFee, insufficient balance, bad params', () => {
    const ctx = setup(); const u = ctx.addState(2_000n);
    expect(() => ctx.leash.buildPay({ stateUtxo: u, agentPrivateKey: ctx.agent.priv, payTo: ctx.server.address, amount: 1_000n, requestHash: H(1), elapsedAdd: 0n, fee: MAX_FEE + 1n })).toThrow(/maxFee/);
    expect(() => pay(ctx, u, 1_000n)).toThrow(/insufficient leash balance/);
    expect(() => setup({ allow: [] })).toThrow(/allow-list/);
    expect(() => setup({ period: 70_000n })).toThrow(/period/);
    expect(() => setup({ allow: [new Uint8Array()] })).toThrow(/anyone-can-spend/);
    for (const bad of ['', 'invalid', '00'.repeat(31), '00'.repeat(33), 'AB'.repeat(32), 'zz'.repeat(32)]) {
      expect(() => setup({ stateCategory: bad }), bad).toThrow(/stateCategory must be 64 lowercase hex/);
    }
    const k = mkKey();
    expect(() => setup({ allow: [k.lock, k.lock, k.lock, k.lock] })).toThrow(/allow-list/);
  });
  it('security review 16.10: refuses trivial allow entries, non-P2PKH owner lock, agent == owner', () => {
    for (const bad of [Uint8Array.of(0x51), Uint8Array.of(0x00), Uint8Array.of(0x6a), Uint8Array.of(0x51, 0x51, 0x87),
      Uint8Array.from([0x6a, 0x04, 1, 2, 3, 4]), Uint8Array.from([0x76, 0xa9, 0x14, ...new Uint8Array(20), 0x88, 0x51])]) {
      expect(() => setup({ allow: [bad] }), binToHex(bad)).toThrow(/not a standard P2PKH\/P2SH/);
    }
    const k = mkKey();
    expect(() => setup({ allow: [k.lock, Uint8Array.of(0x51)] })).toThrow(/not a standard/);
    // P2SH20 and P2SH32 recipients are fine
    expect(() => setup({ allow: [Uint8Array.from([0xa9, 0x14, ...new Uint8Array(20).fill(7), 0x87])] })).not.toThrow();
    expect(() => setup({ allow: [Uint8Array.from([0xaa, 0x20, ...new Uint8Array(32).fill(7), 0x87])] })).not.toThrow();
    // owner lock: 25 bytes but not P2PKH (OP_TRUE padding) is refused
    const fake = new Uint8Array(25).fill(0x51);
    expect(() => setup({ ownerLock: fake })).toThrow(/ownerLock must be a standard/);
    expect(() => setup({ ownerLock: Uint8Array.from([0xa9, 0x14, ...new Uint8Array(20), 0x87]) })).toThrow(/ownerLock/);
    // agent key == owner key
    const same = mkKey();
    expect(() => setup({ agentPkh: same.pkh, ownerLock: same.lock })).toThrow(/agent key must differ/);
  });
});
