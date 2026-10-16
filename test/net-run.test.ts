// scripts/net-run-lib.ts: security review 2026-10-16, section 4 (state before broadcast, withdraw recovery,
// owner address derivation, chipnet key in the mainnet file, loss ceiling before sending, mainnet barrier).
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { binToHex } from '@bitauth/libauth';
import { MockNetworkProvider, randomUtxo, type SpendableUtxo } from 'cashscript';
import {
  CAPS, EXIT, MAINNET_ABS_MAX_LOSS, addressOfPkh, executeRun, executeWithdraw, knownTestnetPrivs, loadKeys, loadState,
  mainnetConfirmation, mainnetGate, planRun, saveStateAtomic, type Ctx, type Keys,
} from '../scripts/net-run-lib.js';
import { AgentLeash, lockingBytecodeOf } from '../src/index.js';
import { mkKey, type Key } from './helpers.js';

type Hook = (hex: string, n: number) => 'ok' | 'lose-response' | 'reject';
class HookedProvider extends MockNetworkProvider {
  sent: string[] = [];
  hook: Hook = () => 'ok';
  onSend?: (n: number) => void;
  async sendRawTransaction(hex: string): Promise<string> {
    const n = this.sent.length;
    this.sent.push(hex);
    this.onSend?.(n);
    const h = this.hook(hex, n);
    if (h === 'reject') throw new Error('mock node: rejected (test)');
    const txid = await super.sendRawTransaction(hex);
    if (h === 'lose-response') throw new Error('connection lost (test)');
    return txid;
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), 'netrun-'));
const keysOf = (owner: Key, payee: Key): Keys => ({ owner: { privHex: binToHex(owner.priv), pkhHex: binToHex(owner.pkh), address: owner.address }, payeeAddress: payee.address });
const sum = (u: SpendableUtxo[]) => u.reduce((s, x) => s + x.satoshis, 0n);

function mkCtx(over: Partial<Ctx> = {}) {
  const dir = tmp();
  const provider = new HookedProvider();
  const owner = mkKey(), payee = mkKey();
  const logs: Record<string, unknown>[] = [];
  const ctx: Ctx = {
    net: 'chipnet', provider, keys: keysOf(owner, payee), caps: CAPS.chipnet, broadcast: true,
    statePath: join(dir, 'net-run-chipnet.json'), historyPath: join(dir, 'net-run-chipnet-history.jsonl'),
    log: (e) => logs.push(e), pollMs: 0, polls: 3, ...over,
  };
  return { ctx, provider, owner, payee, logs, dir };
}

describe('net-run: full run on the mock network', () => {
  it('state (agent key + params) is on disk before the first broadcast; run pays, attack refused, owner withdraws', async () => {
    const { ctx, provider, owner, payee } = mkCtx();
    provider.addUtxo(owner.address, randomUtxo({ satoshis: 100_000n, vout: 1 })); // vout != 0 -> self-send path
    const seen: any[] = [];
    provider.onSend = () => seen.push(loadState(ctx.statePath));
    const code = await executeRun(ctx);
    expect(code).toBe(EXIT.ok);
    // every broadcast happened with the state file present; the first one already had the agent key and the leash
    expect(seen.length).toBe(5); // self-send, genesis, pay, attack (rejected), withdraw
    expect(seen[0]).toMatchObject({ closed: false, phase: 'prepared' });
    expect(seen[0].agentPrivHex).toMatch(/^[0-9a-f]{64}$/);
    const rebuilt = new AgentLeash({
      stateCategory: seen[0].stateCategory, agentPkh: Buffer.from(seen[0].agentPkh, 'hex'), ownerLock: Buffer.from(seen[0].ownerLock, 'hex'),
      allow: seen[0].allow.map((a: string) => Buffer.from(a, 'hex')), limit: BigInt(seen[0].limit), period: BigInt(seen[0].period), maxFee: BigInt(seen[0].maxFee),
    }, provider);
    expect(rebuilt.tokenAddress).toBe(seen[0].leash);
    const st = loadState(ctx.statePath);
    expect(st).toMatchObject({ closed: true, phase: 'closed', closeReason: 'withdrawn' });
    expect(st.genesisTxid).toBe(st.plannedGenesisTxid);
    expect(st.selfSendTxid).toBe(st.plannedSelfSendTxid);
    expect(await provider.getUtxos(st.leash)).toHaveLength(0);
    expect(sum(await provider.getUtxos(payee.address))).toBe(CAPS.chipnet.pay);
    // owner lost at most the planned ceiling
    const left = sum(await provider.getUtxos(owner.address));
    expect(100_000n - left).toBeLessThanOrEqual(BigInt(st.plannedMaxLoss));
    expect(readdirSync(ctx.statePath.replace(/[\\/][^\\/]+$/, '')).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
  });

  it('dry run: builds and checks everything, sends nothing, writes nothing', async () => {
    const { ctx, provider, owner, logs } = mkCtx({ broadcast: false });
    provider.addUtxo(owner.address, randomUtxo({ satoshis: 100_000n, vout: 1 }));
    expect(await executeRun(ctx)).toBe(EXIT.ok);
    expect(provider.sent).toHaveLength(0);
    expect(existsSync(ctx.statePath)).toBe(false);
    expect(logs.filter((l) => l.dryRun).map((l) => [l.label, l.localCheck])).toEqual([['self-send (vout 0 for genesis)', 'ok'], ['genesis', 'ok']]);
  });

  it('a second run is refused while the previous one is open; a closed one goes to history', async () => {
    const { ctx, provider, owner } = mkCtx();
    provider.addUtxo(owner.address, randomUtxo({ satoshis: 200_000n, vout: 1 }));
    saveStateAtomic(ctx.statePath, { leash: 'bchtest:x', closed: false });
    await expect(executeRun(ctx)).rejects.toThrow(/still open/);
    expect(provider.sent).toHaveLength(0);
    saveStateAtomic(ctx.statePath, { leash: 'bchtest:old', closed: true });
    expect(await executeRun(ctx)).toBe(EXIT.ok);
    expect(readFileSync(ctx.historyPath, 'utf8')).toContain('bchtest:old');
  });
});

describe('net-run: recovery from the saved state', () => {
  it('genesis broadcast but the response is lost: run reconciles and sweeps the leash back (exit 3)', async () => {
    const { ctx, provider, owner } = mkCtx();
    provider.addUtxo(owner.address, { ...randomUtxo({ satoshis: 100_000n }), vout: 0 }); // no self-send
    provider.hook = (_h, n) => (n === 0 ? 'lose-response' : 'ok');
    expect(await executeRun(ctx)).toBe(EXIT.demoStepFailed);
    const st = loadState(ctx.statePath);
    expect(st).toMatchObject({ closed: true, closeReason: 'withdrawn' });
    expect(await provider.getUtxos(st.leash)).toHaveLength(0);
    expect(sum(await provider.getUtxos(owner.address))).toBeGreaterThan(100_000n - 3_000n);
  });

  it('process died after genesis: `withdraw` from the file alone (fresh context) recovers the funds', async () => {
    const { ctx, provider, owner } = mkCtx();
    provider.addUtxo(owner.address, { ...randomUtxo({ satoshis: 100_000n }), vout: 0 });
    const plan = await planRun(ctx);
    saveStateAtomic(ctx.statePath, plan.state);
    await provider.sendRawTransaction(plan.genesis.build()); // ... and the process is gone
    expect(sum(await provider.getUtxos(plan.state.leash))).toBe(CAPS.chipnet.fund);
    const fresh: Ctx = { ...ctx, log: () => {} };
    expect(await executeWithdraw(fresh)).toBe(EXIT.ok);
    expect(await provider.getUtxos(plan.state.leash)).toHaveLength(0);
    expect(loadState(ctx.statePath)).toMatchObject({ closed: true, closeReason: 'withdrawn' });
    expect(await executeWithdraw(fresh)).toBe(EXIT.ok); // idempotent
  });

  it('genesis rejected by the node: run closes as "never reached the network", nothing stuck', async () => {
    const { ctx, provider, owner } = mkCtx();
    provider.addUtxo(owner.address, { ...randomUtxo({ satoshis: 100_000n }), vout: 0 });
    provider.hook = (_h, n) => (n === 0 ? 'reject' : 'ok');
    expect(await executeRun(ctx)).toBe(EXIT.demoStepFailed);
    expect(loadState(ctx.statePath)).toMatchObject({ closed: true, closeReason: expect.stringMatching(/never reached/) });
  });

  it('withdraw rejected: exit 1 and the run stays open; a later withdraw succeeds', async () => {
    const { ctx, provider, owner } = mkCtx();
    provider.addUtxo(owner.address, { ...randomUtxo({ satoshis: 100_000n }), vout: 0 });
    // genesis, pay, attack, then the withdraw (4th send) is rejected
    provider.hook = (_h, n) => (n === 3 ? 'reject' : 'ok');
    expect(await executeRun(ctx)).toBe(EXIT.fundsMayRemain);
    const st = loadState(ctx.statePath);
    expect(st.closed).toBe(false);
    expect(sum(await provider.getUtxos(st.leash))).toBeGreaterThan(0n);
    provider.hook = () => 'ok';
    expect(await executeWithdraw(ctx)).toBe(EXIT.ok);
    expect(await provider.getUtxos(st.leash)).toHaveLength(0);
  });

  it('withdraw refuses a state of another owner and a tampered leash address', async () => {
    const { ctx, provider, owner } = mkCtx();
    provider.addUtxo(owner.address, { ...randomUtxo({ satoshis: 100_000n }), vout: 0 });
    const plan = await planRun(ctx);
    saveStateAtomic(ctx.statePath, { ...plan.state, leash: 'bchtest:tampered' });
    expect(await executeWithdraw(ctx)).toBe(EXIT.refused);
    saveStateAtomic(ctx.statePath, plan.state);
    const other = mkKey();
    expect(await executeWithdraw({ ...ctx, keys: { ...ctx.keys, owner: keysOf(other, other).owner } })).toBe(EXIT.refused);
  });
});

describe('net-run: loss ceiling before any send', () => {
  it('refuses when fund + fees exceed maxLoss, before sending', async () => {
    const { ctx, provider, owner } = mkCtx();
    provider.addUtxo(owner.address, randomUtxo({ satoshis: 100_000n, vout: 1 }));
    await expect(executeRun({ ...ctx, caps: { ...CAPS.chipnet, maxLoss: CAPS.chipnet.fund } })).rejects.toThrow(/exceed maxLoss/);
    // fee caps are real: a genesis fee cap below the actual fee refuses too
    await expect(executeRun({ ...ctx, caps: { ...CAPS.chipnet, genesisFeeMax: 10n } })).rejects.toThrow(/genesis fee/);
    // a self-send that would need many inputs is refused by the self-send fee cap
    const { ctx: c2, provider: p2, owner: o2 } = mkCtx();
    for (let i = 0; i < 40; i++) p2.addUtxo(o2.address, randomUtxo({ satoshis: 1_000n, vout: 1 }));
    await expect(executeRun(c2)).rejects.toThrow(/self-send needs/);
    expect(provider.sent).toHaveLength(0);
    expect(p2.sent).toHaveLength(0);
    expect(existsSync(ctx.statePath)).toBe(false);
  });

  it('caps are internally consistent and mainnet stays under the absolute ceiling', () => {
    for (const c of Object.values(CAPS)) expect(c.fund + c.selfSendFeeMax + c.genesisFeeMax + c.withdrawFeeMax).toBeLessThanOrEqual(c.maxLoss);
    expect(CAPS.mainnet.maxLoss).toBeLessThanOrEqual(MAINNET_ABS_MAX_LOSS);
  });
});

describe('net-run: keys and the mainnet barrier', () => {
  let dir: string;
  const owner = mkKey(), payee = mkKey();
  const mainAddr = (k: Key) => addressOfPkh(k.pkh, 'mainnet');
  const mainFile = (o: object) => writeFileSync(join(dir, 'bch_mainnet_agentleash.json'), JSON.stringify(o));
  const good = () => ({ network: 'mainnet', owner: { privHex: binToHex(owner.priv), pkhHex: binToHex(owner.pkh), address: mainAddr(owner) }, payee: { address: mainAddr(payee) } });
  beforeEach(() => { dir = tmp(); });

  it('mainnet file: accepted when consistent', () => {
    mainFile(good());
    expect(loadKeys('mainnet', dir).owner.address).toBe(mainAddr(owner));
  });
  it('mainnet file: network field required', () => {
    const g = good(); delete (g as any).network; mainFile(g);
    expect(() => loadKeys('mainnet', dir)).toThrow(/network.*mainnet/);
    mainFile({ ...good(), network: 'chipnet' });
    expect(() => loadKeys('mainnet', dir)).toThrow(/network/);
  });
  it('owner address is derived from the key and compared with the file', () => {
    const other = mkKey();
    mainFile({ ...good(), owner: { ...good().owner, address: mainAddr(other) } });
    expect(() => loadKeys('mainnet', dir)).toThrow(/not the address of the owner key/);
    mainFile({ ...good(), owner: { ...good().owner, address: owner.address } }); // chipnet address in a mainnet file
    expect(() => loadKeys('mainnet', dir)).toThrow(/not the address of the owner key/);
    mainFile({ ...good(), owner: { ...good().owner, pkhHex: binToHex(other.pkh) } });
    expect(() => loadKeys('mainnet', dir)).toThrow(/pkhHex/);
  });
  it('payee: wrong network and owner == payee refused', () => {
    mainFile({ ...good(), payee: { address: payee.address } });
    expect(() => loadKeys('mainnet', dir)).toThrow(/not a mainnet address/);
    mainFile({ ...good(), payee: { address: mainAddr(owner) } });
    expect(() => loadKeys('mainnet', dir)).toThrow(/payee must differ/);
  });
  it('payee entry saying another network is refused even with a mainnet address (Jules review 17.10)', () => {
    mainFile({ ...good(), payee: { network: 'chipnet', address: mainAddr(payee) } });
    expect(() => loadKeys('mainnet', dir)).toThrow(/payee entry says network=chipnet/);
    mainFile({ ...good(), payee: { network: 'mainnet', address: mainAddr(payee) } });
    expect(loadKeys('mainnet', dir).payeeAddress).toBe(mainAddr(payee));
  });
  it('a chipnet or public demo key copied into the mainnet file is refused', () => {
    const chip = { network: 'chipnet', wallets: [{ network: 'chipnet', privHex: binToHex(owner.priv) }] };
    writeFileSync(join(dir, 'bch_chipnet_wallets.json'), JSON.stringify(chip));
    mainFile(good());
    const repo = tmp();
    expect(() => loadKeys('mainnet', dir, knownTestnetPrivs(dir, repo))).toThrow(/known chipnet\/demo key/);
    // the public web demo agent key too
    const dir2 = tmp(); mkdirSync(join(repo, 'web', 'src'), { recursive: true });
    writeFileSync(join(repo, 'web', 'src', 'demo.json'), JSON.stringify({ label: 'demo', agentPriv: binToHex(owner.priv) }));
    writeFileSync(join(dir2, 'bch_mainnet_agentleash.json'), JSON.stringify(good()));
    expect(() => loadKeys('mainnet', dir2, knownTestnetPrivs(dir2, repo))).toThrow(/known chipnet\/demo key/);
  });
  it('the real repo demo key is collected', () => {
    const repo = join(__dirname, '..');
    const demo = JSON.parse(readFileSync(join(repo, 'web', 'src', 'demo.json'), 'utf8'));
    expect(demo.chipnet.agentPriv).toMatch(/^[0-9a-f]{64}$/i);
    expect(knownTestnetPrivs(tmp(), repo).has(String(demo.chipnet.agentPriv).toLowerCase())).toBe(true);
  });
  it('chipnet files saying another network are refused', () => {
    writeFileSync(join(dir, 'bch_chipnet_wallets.json'), JSON.stringify({ network: 'mainnet', wallets: [] }));
    writeFileSync(join(dir, 'bch_chipnet_agentleash_server.json'), JSON.stringify({ network: 'chipnet', address: payee.address }));
    expect(() => loadKeys('chipnet', dir)).toThrow(/network=mainnet/);
  });

  it('mainnet gate: env flag AND confirmation with the loss ceiling and the owner address tail', () => {
    const base = { net: 'mainnet' as const, cmd: 'run', broadcast: true, caps: CAPS.mainnet, ownerAddress: mainAddr(owner) };
    const ok = mainnetConfirmation(CAPS.mainnet, base.ownerAddress);
    expect(ok).toBe(`${CAPS.mainnet.maxLoss}:${base.ownerAddress.slice(-6)}`);
    expect(() => mainnetGate({ ...base, env: {}, confirm: ok })).toThrow(/AGENTLEASH_MAINNET_OK/);
    expect(() => mainnetGate({ ...base, env: { AGENTLEASH_MAINNET_OK: '1' }, confirm: ok })).toThrow(/AGENTLEASH_MAINNET_OK/);
    expect(() => mainnetGate({ ...base, env: { AGENTLEASH_MAINNET_OK: 'yes' } })).toThrow(/confirm-mainnet/);
    expect(() => mainnetGate({ ...base, env: { AGENTLEASH_MAINNET_OK: 'yes' }, confirm: `99999:${base.ownerAddress.slice(-6)}` })).toThrow(/confirm-mainnet/);
    expect(() => mainnetGate({ ...base, env: { AGENTLEASH_MAINNET_OK: 'yes' }, confirm: `${CAPS.mainnet.maxLoss}:zzzzzz` })).toThrow(/confirm-mainnet/);
    expect(() => mainnetGate({ ...base, env: { AGENTLEASH_MAINNET_OK: 'yes' }, confirm: ok })).not.toThrow();
    // withdraw only pays the owner: env flag is enough; dry runs and chipnet are not gated
    expect(() => mainnetGate({ ...base, cmd: 'withdraw', env: { AGENTLEASH_MAINNET_OK: 'yes' } })).not.toThrow();
    expect(() => mainnetGate({ ...base, cmd: 'withdraw', env: {} })).toThrow(/AGENTLEASH_MAINNET_OK/);
    expect(() => mainnetGate({ ...base, broadcast: false, env: {} })).not.toThrow();
    expect(() => mainnetGate({ ...base, caps: { ...CAPS.mainnet, maxLoss: MAINNET_ABS_MAX_LOSS + 1n }, env: { AGENTLEASH_MAINNET_OK: 'yes' }, confirm: ok })).toThrow(/absolute/);
  });

  it('saveStateAtomic replaces the file and leaves no temp file', () => {
    const p = join(dir, 's.json');
    saveStateAtomic(p, { a: 1 }); saveStateAtomic(p, { a: 2 });
    expect(loadState(p)).toEqual({ a: 2 });
    expect(readdirSync(dir)).toEqual(['s.json']);
  });
});

it('net-run genesis outputs: leash gets exactly the fund (lock check sanity)', async () => {
  const { ctx, provider, owner } = mkCtx();
  provider.addUtxo(owner.address, { ...randomUtxo({ satoshis: 100_000n }), vout: 0 });
  const plan = await planRun(ctx);
  const leashLock = binToHex(lockingBytecodeOf(plan.state.leash));
  const toLeash = plan.genesis.outputs.filter((o) => binToHex(lockingBytecodeOf(o.to as string)) === leashLock);
  expect(toLeash.map((o) => o.amount)).toEqual([CAPS.chipnet.fund]);
});
