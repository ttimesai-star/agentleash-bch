import { binToHex, encodeCashAddress, generatePrivateKey, secp256k1, hash160 } from '@bitauth/libauth';
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder, randomUtxo, type Output, type SpendableUtxo } from 'cashscript';
import { AgentLeash, AgentLeashArtifact, categoryToVmBytes, encodeState, p2pkhLock, receiptLockingBytecode, type LeashParams, type LeashState } from '../src/index.js';

export interface Key { priv: Uint8Array; pub: Uint8Array; pkh: Uint8Array; address: string; tokenAddress: string; lock: Uint8Array; sig: SignatureTemplate }

export function mkKey(): Key {
  const priv = generatePrivateKey();
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pub);
  const enc = (type: 'p2pkh' | 'p2pkhWithTokens') => {
    const r = encodeCashAddress({ prefix: 'bchtest', type, payload: pkh });
    return typeof r === 'string' ? r : r.address;
  };
  return { priv, pub, pkh, address: enc('p2pkh'), tokenAddress: enc('p2pkhWithTokens'), lock: p2pkhLock(pkh), sig: new SignatureTemplate(priv) };
}

export const randomCategory = () => binToHex(generatePrivateKey());
export const H = (n: number) => binToHex(new Uint8Array(32).fill(n)); // deterministic request hash

export const LIMIT = 10_000n;
export const PERIOD = 10n;
export const MAX_FEE = 2_000n;

/**
 * Contract-level tests only: an AgentLeash whose params skip validateParams (e.g. a 1-byte allow entry),
 * to show what the contract itself enforces when the SDK guard is bypassed by a hand-made deployment.
 */
export function uncheckedLeash(params: LeashParams, provider: MockNetworkProvider): AgentLeash {
  const [a, b = params.allow[0], c = params.allow[0]] = params.allow;
  const contract = new Contract(AgentLeashArtifact, [categoryToVmBytes(params.stateCategory), params.agentPkh, params.ownerLock,
    a, b, c, params.limit, params.period, params.maxFee], { provider, contractType: 'p2sh32' });
  return Object.assign(Object.create(AgentLeash.prototype), { params, provider, contract }) as AgentLeash;
}

export function setup(over: Partial<LeashParams> = {}, opts: { unchecked?: boolean } = {}) {
  const provider = new MockNetworkProvider();
  const owner = mkKey(), agent = mkKey(), server = mkKey(), server2 = mkKey(), attacker = mkKey();
  const params: LeashParams = {
    stateCategory: randomCategory(),
    agentPkh: agent.pkh,
    ownerLock: owner.lock,
    allow: [server.lock, server2.lock],
    limit: LIMIT,
    period: PERIOD,
    maxFee: MAX_FEE,
    ...over,
  };
  const leash = opts.unchecked ? uncheckedLeash(params, provider) : new AgentLeash(params, provider);
  const addState = (satoshis = 100_000n, state: LeashState = { elapsed: 0n, spent: 0n }, token?: SpendableUtxo['token']): SpendableUtxo =>
    provider.addUtxo(leash.tokenAddress, {
      ...randomUtxo({ satoshis }),
      token: token ?? { category: params.stateCategory, amount: 0n, nft: { capability: 'mutable', commitment: encodeState(state) } },
    }) as SpendableUtxo;
  const addP2pkh = (k: Key, satoshis = 50_000n) => provider.addUtxo(k.address, randomUtxo({ satoshis })) as SpendableUtxo;
  return { provider, owner, agent, server, server2, attacker, params, leash, addState, addP2pkh };
}

export type Ctx = ReturnType<typeof setup>;

/** Low-level pay builder that skips every SDK safety check, for attack tests. */
export function rawPay(ctx: Ctx, opts: {
  input: SpendableUtxo;
  outputs: Output[];
  elapsedAdd?: bigint;
  sequence?: number;
  signer?: Key;
  claimedPub?: Uint8Array;
  extraInputs?: SpendableUtxo[];
}): TransactionBuilder {
  const signer = opts.signer ?? ctx.agent;
  const elapsedAdd = opts.elapsedAdd ?? 0n;
  const tb = new TransactionBuilder({ provider: ctx.provider })
    .addInput(opts.input, ctx.leash.contract.unlock.pay(opts.claimedPub ?? signer.pub, signer.sig, elapsedAdd),
      { sequence: opts.sequence ?? Number(elapsedAdd) });
  for (const x of opts.extraInputs ?? []) tb.addInput(x, ctx.leash.contract.unlock.pay(signer.pub, signer.sig, elapsedAdd), { sequence: Number(elapsedAdd) });
  return tb.addOutputs(opts.outputs);
}

export const stateOut = (ctx: Ctx, amount: bigint, state: LeashState, category = ctx.params.stateCategory, capability: 'mutable' | 'none' | 'minting' = 'mutable'): Output => ({
  to: ctx.leash.tokenAddress,
  amount,
  token: { category, amount: 0n, nft: { capability, commitment: encodeState(state) } },
});
export const receiptOut = (hash = H(7)): Output => ({ to: receiptLockingBytecode(hash), amount: 0n });
