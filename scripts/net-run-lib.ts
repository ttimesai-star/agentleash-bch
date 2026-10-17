// Logic of scripts/net-run.ts (one capped AgentLeash run on chipnet/mainnet), kept free of process/argv so it
// can be tested on MockNetworkProvider (test/net-run.test.ts). Security review 2026-10-16, section 4:
//   (a) the run state (agent key, every contract parameter, planned txids) is written to local/ atomically
//       BEFORE the first broadcast, so the leash address can always be rebuilt;
//   (b) `withdraw` reconciles an open run from that state: sweeps the leash back to the owner, or closes the
//       run when the genesis never reached the network; non-zero exit when funds may still be on the leash;
//       an empty leash closes the run only on evidence (genesis unknown and never accepted, or one of this
//       run's withdraw txids, recorded before sending, known to the network) - Jules review 17.10;
//   (c) the owner address is derived from the key and compared with the secrets file;
//   (d) a mainnet secrets file must say network=mainnet and must not reuse any known chipnet/demo key;
//   (e) the loss ceiling (fund + all fees) is checked BEFORE anything is sent;
//   (f) mainnet broadcast needs AGENTLEASH_MAINNET_OK=yes AND --confirm-mainnet=<ceiling sats>:<owner address tail>.
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, writeSync, appendFileSync } from 'fs';
import { binToHex, encodeCashAddress, generatePrivateKey, hashTransaction, hexToBin } from '@bitauth/libauth';
import { SignatureTemplate, TransactionBuilder, type NetworkProvider, type SpendableUtxo } from 'cashscript';
import {
  AgentLeash, buildAttack, buildGenesis, computeRequestHash, lockingBytecodeOf, localReason, p2pkhLock, pkhOfPrivateKey,
  type LeashParams,
} from '../src/index.js';

export type Net = 'chipnet' | 'mainnet';

export interface Caps {
  fund: bigint; limit: bigint; period: bigint; maxFee: bigint; pay: bigint;
  /** Fee caps per owner transaction (self-send, genesis, withdraw). */
  selfSendFeeMax: bigint; genesisFeeMax: bigint; withdrawFeeMax: bigint;
  /** Hard loss ceiling of one run: fund + every owner fee. Checked before anything is sent. */
  maxLoss: bigint;
}

/** Absolute mainnet ceiling, independent of CAPS (about 0.1 USD at 500 USD/BCH; the brief allows <= 3 USD). */
export const MAINNET_ABS_MAX_LOSS = 25_000n;

export const CAPS: Record<Net, Caps> = {
  mainnet: { fund: 20_000n, limit: 6_000n, period: 3n, maxFee: 1_500n, pay: 1_000n, selfSendFeeMax: 1_000n, genesisFeeMax: 1_000n, withdrawFeeMax: 1_000n, maxLoss: 23_000n },
  chipnet: { fund: 30_000n, limit: 6_000n, period: 3n, maxFee: 2_000n, pay: 1_000n, selfSendFeeMax: 2_000n, genesisFeeMax: 2_000n, withdrawFeeMax: 2_000n, maxLoss: 36_000n },
};

export const prefixOf = (net: Net) => (net === 'mainnet' ? 'bitcoincash' : 'bchtest');

export function addressOfPkh(pkh: Uint8Array, net: Net, tokens = false): string {
  const r = encodeCashAddress({ prefix: prefixOf(net), type: tokens ? 'p2pkhWithTokens' : 'p2pkh', payload: pkh });
  return typeof r === 'string' ? r : r.address;
}

export interface OwnerKey { privHex: string; pkhHex: string; address: string }
export interface Keys { owner: OwnerKey; payeeAddress: string }

const PRIV_RE = /^[0-9a-f]{64}$/i;

/** Every 64-hex value under a key containing "priv" (privHex, agentPriv, agentPrivHex, ...), recursively. */
export function collectPrivs(x: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(x)) for (const v of x) collectPrivs(v, out);
  else if (x && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if (/priv/i.test(k) && typeof v === 'string' && PRIV_RE.test(v)) out.add(v.toLowerCase());
      else collectPrivs(v, out);
    }
  }
  return out;
}

/**
 * JSON.stringify replacer for net-run logs (Jules review 17.10): bigint -> string; a value under a key containing
 * "priv" -> [REDACTED]; every known private key (owner + this run's agent) is cut out of any string, whole or as
 * a substring. Other 64-hex values (txids, NFT categories) stay visible: a txid looks like a key but is public.
 */
export function logReplacer(secrets: Set<string>): (k: string, v: unknown) => unknown {
  return (k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (k && /priv/i.test(k)) return '[REDACTED]';
    if (typeof v === 'string') return redactSecrets(v, secrets);
    return v;
  };
}

/**
 * Cut every known secret out of a string, case-insensitively (Jules review 17.10, stage 5): the secret itself
 * may be stored in any case, and it is matched literally (a corrupted state file must not turn a "key" into a
 * regular expression that throws inside the logger).
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let s = text;
  for (const sec of secrets) {
    if (typeof sec !== 'string' || !sec) continue;
    const lower = sec.toLowerCase();
    if (s.toLowerCase().includes(lower)) s = s.replace(new RegExp(lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[REDACTED]');
  }
  return s;
}

/**
 * Keys that exist on chipnet or in public demos: chipnet/testnet secrets files, the public web demo agent,
 * chipnet run states. None of them may ever hold mainnet money.
 */
export function knownTestnetPrivs(secretsDir: string, repoDir: string): Set<string> {
  const out = new Set<string>();
  const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return undefined; } };
  if (existsSync(secretsDir)) {
    for (const f of readdirSync(secretsDir)) if (/(chipnet|testnet)/i.test(f) && f.endsWith('.json')) collectPrivs(readJson(`${secretsDir}/${f}`), out);
  }
  for (const f of [`${repoDir}/web/src/demo.json`, `${repoDir}/local/net-run-chipnet.json`]) if (existsSync(f)) collectPrivs(readJson(f), out);
  const hist = `${repoDir}/local/net-run-chipnet-history.jsonl`;
  if (existsSync(hist)) for (const l of readFileSync(hist, 'utf8').split('\n')) if (l.trim()) { try { collectPrivs(JSON.parse(l), out); } catch { /* skip */ } }
  return out;
}

/**
 * Load and cross-check the owner key and the payee address for `net`.
 * chipnet: bch_chipnet_wallets.json (wallets[0] = owner) + bch_chipnet_agentleash_server.json (payee).
 * mainnet: bch_mainnet_agentleash.json { "network": "mainnet", "owner": { privHex, pkhHex, address }, "payee": { address } }.
 */
export function loadKeys(net: Net, secretsDir: string, forbiddenPrivs: Set<string> = new Set()): Keys {
  let owner: OwnerKey, payeeAddress: string;
  if (net === 'chipnet') {
    const w = JSON.parse(readFileSync(`${secretsDir}/bch_chipnet_wallets.json`, 'utf8'));
    const s = JSON.parse(readFileSync(`${secretsDir}/bch_chipnet_agentleash_server.json`, 'utf8'));
    for (const [n, d] of [['wallets', w], ['server', s]] as const) {
      if (d.network !== undefined && d.network !== 'chipnet') throw new Error(`refusing: chipnet ${n} file says network=${d.network}`);
    }
    owner = w.wallets[0]; payeeAddress = s.address;
  } else {
    const f = `${secretsDir}/bch_mainnet_agentleash.json`;
    if (!existsSync(f)) throw new Error(`missing ${f} (network, owner key, payee address); see the header of scripts/net-run.ts`);
    const m = JSON.parse(readFileSync(f, 'utf8'));
    if (m.network !== 'mainnet') throw new Error(`refusing: ${f} must contain "network": "mainnet" (found ${JSON.stringify(m.network)})`);
    if (m.owner?.network !== undefined && m.owner.network !== 'mainnet') throw new Error(`refusing: owner entry says network=${m.owner.network}`);
    // Jules review 17.10: same rule for the payee entry (its address prefix is checked below as well)
    if (m.payee?.network !== undefined && m.payee.network !== 'mainnet') throw new Error(`refusing: payee entry says network=${m.payee.network}`);
    owner = m.owner; payeeAddress = m.payee?.address;
  }
  if (!owner || typeof owner.privHex !== 'string' || !PRIV_RE.test(owner.privHex)) throw new Error('owner.privHex must be 64 hex chars');
  if (typeof payeeAddress !== 'string') throw new Error('payee address missing');
  if (net === 'mainnet' && forbiddenPrivs.has(owner.privHex.toLowerCase())) {
    throw new Error('refusing: the mainnet owner key is a known chipnet/demo key; generate a fresh dedicated mainnet key');
  }
  const pkh = pkhOfPrivateKey(hexToBin(owner.privHex));
  if (binToHex(pkh) !== String(owner.pkhHex).toLowerCase()) throw new Error('owner key does not match pkhHex');
  const derived = addressOfPkh(pkh, net);
  if (String(owner.address).toLowerCase() !== derived) throw new Error(`owner address in the file (${owner.address}) is not the address of the owner key (${derived})`);
  if (!payeeAddress.toLowerCase().startsWith(`${prefixOf(net)}:`)) throw new Error(`refusing: payee ${payeeAddress} is not a ${net} address`);
  const payeeLock = lockingBytecodeOf(payeeAddress);
  if (binToHex(payeeLock) === binToHex(p2pkhLock(pkh))) throw new Error('payee must differ from the owner');
  return { owner: { privHex: owner.privHex.toLowerCase(), pkhHex: binToHex(pkh), address: derived }, payeeAddress };
}

/** The exact confirmation the operator must pass for a mainnet `run --broadcast`. */
export const mainnetConfirmation = (caps: Caps, ownerAddress: string) => `${caps.maxLoss}:${ownerAddress.slice(-6)}`;

/** Mainnet barrier. Returns nothing or throws. withdraw only needs the env flag: it can only pay the owner. */
export function mainnetGate(o: { net: Net; cmd: string; broadcast: boolean; env: Record<string, string | undefined>; confirm?: string; caps: Caps; ownerAddress: string }): void {
  if (o.net !== 'mainnet' || !o.broadcast) return;
  if (o.caps.maxLoss > MAINNET_ABS_MAX_LOSS) throw new Error(`mainnet ceiling ${o.caps.maxLoss} above the absolute ${MAINNET_ABS_MAX_LOSS}`);
  if (o.env.AGENTLEASH_MAINNET_OK !== 'yes') throw new Error('mainnet broadcast needs AGENTLEASH_MAINNET_OK=yes (owner approval)');
  if (o.cmd === 'withdraw') return;
  const want = mainnetConfirmation(o.caps, o.ownerAddress);
  if (o.confirm !== want) {
    throw new Error('mainnet run needs --confirm-mainnet=<max loss in sats>:<last 6 chars of the owner address>; `status` prints the value after showing the caps');
  }
}

// ---------------------------------------------------------------- state

export interface RunState {
  version: 1;
  net: Net;
  createdAt: string;
  phase: 'prepared' | 'genesis-sent' | 'closed';
  closed: boolean;
  closeReason?: string;
  ownerAddress: string;
  payeeAddress: string;
  /** Agent private key of this run (local/ is gitignored; never printed). */
  agentPrivHex: string;
  agentPkh: string;
  ownerLock: string;
  allow: string[];
  limit: string; period: string; maxFee: string; fund: string;
  /** NFT category = genesis input txid (the self-send txid when a self-send is needed). */
  stateCategory: string;
  leash: string;
  plannedSelfSendTxid?: string;
  plannedGenesisTxid: string;
  plannedMaxLoss: string;
  selfSendTxid?: string;
  genesisTxid?: string;
  withdrawTxid?: string;
  /** Planned txid of every owner withdraw, written BEFORE it is sent: positive evidence for "already swept". */
  withdrawAttempts?: string[];
}

/** Write via a temp file in the same directory + fsync + rename: the file is either the old or the new state. */
export function saveStateAtomic(path: string, state: object): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try { writeSync(fd, JSON.stringify(state, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function loadState(path: string): any | undefined {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

export function paramsFromState(st: RunState): LeashParams {
  return {
    stateCategory: st.stateCategory, agentPkh: hexToBin(st.agentPkh), ownerLock: hexToBin(st.ownerLock), allow: st.allow.map(hexToBin),
    limit: BigInt(st.limit), period: BigInt(st.period), maxFee: BigInt(st.maxFee),
  };
}

// ---------------------------------------------------------------- flows

export interface Ctx {
  net: Net;
  provider: NetworkProvider;
  keys: Keys;
  caps: Caps;
  broadcast: boolean;
  statePath: string;
  historyPath: string;
  log: (e: Record<string, unknown>) => void;
  /** Private keys (lowercase hex) the log must never show; the run adds its agent key here. */
  secrets?: Set<string>;
  /** Delay between polls for a coin to show up (ms) and number of polls. */
  pollMs?: number;
  polls?: number;
}

/** Exit codes of run/withdraw. */
export const EXIT = { ok: 0, fundsMayRemain: 1, refused: 2, demoStepFailed: 3 } as const;

export const feeOf = (tb: TransactionBuilder): bigint =>
  tb.inputs.reduce((s, i) => s + i.satoshis, 0n) - tb.outputs.reduce((s, o) => s + o.amount, 0n);

const plannedTxid = (tb: TransactionBuilder) => hashTransaction(hexToBin(tb.build()));

async function send(ctx: Ctx, label: string, tb: TransactionBuilder, extra: Record<string, unknown> = {}): Promise<{ txid?: string; planned: string; error?: string }> {
  const hex = tb.build();
  const planned = hashTransaction(hexToBin(hex));
  if (!ctx.broadcast) { ctx.log({ label, dryRun: true, plannedTxid: planned, bytes: hex.length / 2, fee: feeOf(tb), localCheck: localReason(tb) || 'ok', ...extra }); return { planned }; }
  try {
    const txid = await ctx.provider.sendRawTransaction(hex);
    if (txid !== planned) { ctx.log({ label, ok: false, error: `node returned txid ${txid}, expected ${planned}`, ...extra }); return { planned, error: 'txid mismatch' }; }
    ctx.log({ label, ok: true, txid, bytes: hex.length / 2, fee: feeOf(tb), ...extra });
    return { txid, planned };
  } catch (e: any) {
    const error = String(e?.originalError ?? e?.message ?? e).split('\n').filter((l) => !/^[0-9a-f]{120,}$/i.test(l)).join(' ');
    ctx.log({ label, ok: false, nodeError: error, ...extra });
    return { planned, error };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Plan { selfSend?: TransactionBuilder; genesis: TransactionBuilder; state: RunState; selfSendFee: bigint; genesisFee: bigint; leash: AgentLeash }

/** Build every owner transaction of the run and check every cap. Sends nothing, writes nothing. */
export async function planRun(ctx: Ctx, agentPriv: Uint8Array = generatePrivateKey()): Promise<Plan> {
  const { caps, provider, keys: { owner, payeeAddress } } = ctx;
  if (caps.fund + caps.selfSendFeeMax + caps.genesisFeeMax + caps.withdrawFeeMax > caps.maxLoss) throw new Error('caps: fund + fee caps exceed maxLoss');
  if (ctx.net === 'mainnet' && caps.maxLoss > MAINNET_ABS_MAX_LOSS) throw new Error('caps: mainnet ceiling above the absolute maximum');
  const ownerSig = new SignatureTemplate(hexToBin(owner.privHex));
  const coins = (await provider.getUtxos(owner.address)).filter((u) => !u.token);
  let gen: SpendableUtxo | undefined = coins.find((u) => u.vout === 0 && u.satoshis >= caps.fund + 2_000n);
  let selfSend: TransactionBuilder | undefined;
  let selfSendFee = 0n;
  if (!gen) {
    const pick: SpendableUtxo[] = [];
    let total = 0n;
    for (const c of [...coins].sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))) { pick.push(c); total += c.satoshis; if (total >= caps.fund + 4_000n) break; }
    if (total < caps.fund + 4_000n) throw new Error(`owner has ${total} sats in plain coins, needs ${caps.fund + 4_000n}`);
    selfSendFee = 150n * BigInt(pick.length) + 100n;
    if (selfSendFee > caps.selfSendFeeMax) throw new Error(`cap: self-send needs ${pick.length} inputs, fee ${selfSendFee} > ${caps.selfSendFeeMax}; consolidate the owner coins first`);
    selfSend = new TransactionBuilder({ provider }).addInputs(pick, ownerSig.unlockP2PKH()).addOutput({ to: owner.address, amount: total - selfSendFee });
    if (feeOf(selfSend) !== selfSendFee) throw new Error('self-send fee mismatch');
    gen = { txid: plannedTxid(selfSend), vout: 0, satoshis: total - selfSendFee, lockingBytecode: binToHex(lockingBytecodeOf(owner.address)) } as SpendableUtxo;
  }
  const params = {
    agentPkh: pkhOfPrivateKey(agentPriv), ownerLock: p2pkhLock(hexToBin(owner.pkhHex)), allow: [lockingBytecodeOf(payeeAddress)],
    limit: caps.limit, period: caps.period, maxFee: caps.maxFee,
  };
  const { leash, builder: genesis } = buildGenesis({ provider, ownerUtxo: gen, ownerUnlocker: ownerSig.unlockP2PKH(), ownerAddress: owner.address, params, fund: caps.fund });
  const genesisFee = feeOf(genesis);
  if (genesisFee > caps.genesisFeeMax) throw new Error(`cap: genesis fee ${genesisFee} > ${caps.genesisFeeMax}`);
  // genesis outputs: exactly the fund to the leash, the rest back to the owner
  const ownerLockHex = binToHex(lockingBytecodeOf(owner.address));
  const leashLockHex = binToHex(lockingBytecodeOf(leash.tokenAddress));
  for (const o of genesis.outputs) {
    const lock = binToHex(typeof o.to === 'string' ? lockingBytecodeOf(o.to) : o.to);
    if (lock === leashLockHex ? o.amount !== caps.fund : lock !== ownerLockHex) throw new Error('genesis output not to the leash (fund) or the owner');
  }
  const plannedLoss = selfSendFee + genesisFee + caps.fund + caps.withdrawFeeMax;
  if (plannedLoss > caps.maxLoss) throw new Error(`cap: planned loss ceiling ${plannedLoss} > ${caps.maxLoss}`);
  const state: RunState = {
    version: 1, net: ctx.net, createdAt: new Date().toISOString(), phase: 'prepared', closed: false,
    ownerAddress: owner.address, payeeAddress, agentPrivHex: binToHex(agentPriv), agentPkh: binToHex(params.agentPkh),
    ownerLock: binToHex(params.ownerLock), allow: params.allow.map(binToHex),
    limit: caps.limit.toString(), period: caps.period.toString(), maxFee: caps.maxFee.toString(), fund: caps.fund.toString(),
    stateCategory: gen.txid, leash: leash.tokenAddress,
    plannedSelfSendTxid: selfSend ? gen.txid : undefined, plannedGenesisTxid: plannedTxid(genesis), plannedMaxLoss: plannedLoss.toString(),
  };
  return { selfSend, genesis, state, selfSendFee, genesisFee, leash };
}

/** Archive a closed previous state into the history file; refuse when a previous run is still open. */
export function rotateState(ctx: Ctx): void {
  const prev = loadState(ctx.statePath);
  if (!prev) return;
  if (prev.closed !== true) throw new Error(`an earlier ${ctx.net} run is still open (leash ${prev.leash}); run \`withdraw\` first`);
  appendFileSync(ctx.historyPath, JSON.stringify({ archivedAt: new Date().toISOString(), ...prev }) + '\n', { mode: 0o600 });
}

/** genesis, one agent payment, one attack the network must refuse, owner withdraw. Returns an exit code. */
export async function executeRun(ctx: Ctx, agentPriv?: Uint8Array): Promise<number> {
  if (ctx.broadcast) { const prev = loadState(ctx.statePath); if (prev && prev.closed !== true) throw new Error(`an earlier ${ctx.net} run is still open (leash ${prev.leash}); run \`withdraw\` first`); }
  const plan = await planRun(ctx, agentPriv);
  const { state } = plan;
  ctx.secrets?.add(state.agentPrivHex.toLowerCase());
  ctx.log({ label: 'plan', leash: state.leash, category: state.stateCategory, fund: state.fund, selfSendFee: plan.selfSendFee, genesisFee: plan.genesisFee, plannedMaxLoss: state.plannedMaxLoss });
  if (!ctx.broadcast) {
    if (plan.selfSend) await send(ctx, 'self-send (vout 0 for genesis)', plan.selfSend);
    await send(ctx, 'genesis', plan.genesis, { leash: state.leash, category: state.stateCategory });
    return EXIT.ok;
  }
  // (a) persisted before anything goes out
  rotateState(ctx);
  saveStateAtomic(ctx.statePath, state);
  try { return await broadcastRun(ctx, plan); }
  catch (e: any) {
    // after the first broadcast an exception must not look like a clean refusal: funds may be on the leash
    ctx.log({ label: 'run error', error: String(e?.message ?? e) });
    return EXIT.fundsMayRemain;
  }
}

async function broadcastRun(ctx: Ctx, plan: Plan): Promise<number> {
  const { state } = plan;
  if (plan.selfSend) {
    const r = await send(ctx, 'self-send (vout 0 for genesis)', plan.selfSend);
    if (!r.txid) return reconcileAfterFailure(ctx, state, 'self-send failed');
    state.selfSendTxid = r.txid;
    saveStateAtomic(ctx.statePath, state);
  }
  const g = await send(ctx, 'genesis', plan.genesis, { leash: state.leash, category: state.stateCategory, fund: state.fund });
  if (!g.txid) return reconcileAfterFailure(ctx, state, 'genesis failed');
  state.genesisTxid = g.txid; state.phase = 'genesis-sent';
  saveStateAtomic(ctx.statePath, state);

  let demoOk = true;
  try {
    const live = new AgentLeash(paramsFromState(state), ctx.provider);
    const agentKey = hexToBin(state.agentPrivHex);
    const s1 = await waitState(ctx, live);
    const requestHash = computeRequestHash({ challengeNonce: binToHex(crypto.getRandomValues(new Uint8Array(16))), method: 'GET', url: 'https://tools.agentleash.demo/chain-tip' });
    const p = await send(ctx, `agent pays ${ctx.caps.pay}`, live.buildPay({ stateUtxo: s1, agentPrivateKey: agentKey, payTo: ctx.keys.payeeAddress, amount: ctx.caps.pay, requestHash, elapsedAdd: 0n }), { requestHash });
    if (!p.txid) demoOk = false;
    const s2 = await waitState(ctx, live, p.txid);
    const atk = buildAttack('recipient', { leash: live, stateUtxo: s2, agentPrivateKey: agentKey, realAge: 0n });
    const why = localReason(atk.builder);
    if (!why) { demoOk = false; ctx.log({ label: 'ALERT', error: 'the attack passes local contract evaluation; not sending it' }); }
    else {
      const a = await send(ctx, 'attack: pay a non-allow-listed address (must be rejected)', atk.builder, { localReason: why });
      if (a.txid) { demoOk = false; ctx.log({ label: 'ALERT', error: 'the network accepted the attack transaction' }); }
    }
  } catch (e: any) {
    demoOk = false;
    ctx.log({ label: 'demo step error', error: String(e?.message ?? e) });
  }
  const w = await executeWithdraw(ctx, state);
  if (w !== EXIT.ok) return w;
  return demoOk ? EXIT.ok : EXIT.demoStepFailed;
}

async function reconcileAfterFailure(ctx: Ctx, state: RunState, why: string): Promise<number> {
  ctx.log({ label: 'reconcile', reason: why });
  const w = await executeWithdraw(ctx, state);
  // the run did not happen even when reconciliation closed it cleanly
  return w === EXIT.ok ? EXIT.demoStepFailed : w;
}

async function waitState(ctx: Ctx, live: AgentLeash, spentBy?: string): Promise<SpendableUtxo> {
  const polls = ctx.polls ?? 20;
  for (let i = 0; i < polls; i++) {
    const { state } = await live.getUtxos();
    // after a payment wait for the new state coin, not the spent one a lagging server may still list
    // (a lagging server may still list the spent coin; building on it would make the attack fail for the
    // wrong reason, "missing inputs", instead of the contract rule)
    if (state && (!spentBy || state.txid === spentBy)) return state;
    await sleep(ctx.pollMs ?? 3000);
  }
  throw new Error('state coin not visible');
}

/** Is the transaction known to the network? undefined when the server could not answer. */
async function txKnown(ctx: Ctx, txid: string): Promise<boolean | undefined> {
  try {
    const raw: unknown = await ctx.provider.getRawTransaction(txid);
    // Jules review 17.10, stage 7: "known" only for the raw transaction that hashes to this txid. An empty /
    // null answer used to read as "unknown" (closes a never-confirmed run, exit 0) and any other truthy junk
    // as "known" (closes the run as "already swept", exit 0); both are server errors here, run stays open.
    if (typeof raw === 'string' && /^(?:[0-9a-f]{2})+$/i.test(raw) && hashTransaction(hexToBin(raw)) === txid.toLowerCase()) return true;
    ctx.log({ label: 'getRawTransaction error', txid, error: `unexpected answer: ${typeof raw === 'string' ? `${raw.length} chars` : typeof raw}` });
    return undefined;
  }
  catch (e: any) {
    const m = String(e?.originalError ?? e?.message ?? e);
    // "Unknown" can close a run whose genesis response was lost (exit 0), so only the node's own verbatim answer
    // for an unknown txid counts (BCHN code -5, chipnet 17.10). Any other text, e.g. "Method not found" or
    // "404 Not Found", is a server error: status unknown, run stays open (Jules review 17.10, stage 6).
    if (/no such mempool or blockchain transaction/i.test(m)) return false;
    ctx.log({ label: 'getRawTransaction error', txid, error: m.split('\n')[0] });
    return undefined;
  }
}

/**
 * Sweep the leash of an open run back to the owner (owner path; the agent key is not needed), or close the
 * run when the genesis never reached the network. EXIT.ok only when nothing can be left on the leash.
 */
export async function executeWithdraw(ctx: Ctx, stateArg?: RunState): Promise<number> {
  try { return await withdrawInner(ctx, stateArg); }
  catch (e: any) {
    ctx.log({ label: 'withdraw', error: String(e?.message ?? e) });
    return EXIT.fundsMayRemain;
  }
}

async function withdrawInner(ctx: Ctx, stateArg?: RunState): Promise<number> {
  const state: RunState | undefined = stateArg ?? loadState(ctx.statePath);
  if (!state) { ctx.log({ label: 'withdraw', error: `no run state at ${ctx.statePath}` }); return EXIT.refused; }
  // the agent key joins the redaction set before the first log line about this state (Jules review 17.10, stage 5)
  if (typeof state.agentPrivHex === 'string') ctx.secrets?.add(state.agentPrivHex.toLowerCase());
  if (state.closed) { ctx.log({ label: 'withdraw', note: 'run already closed', closeReason: state.closeReason, withdrawTxid: state.withdrawTxid }); return EXIT.ok; }
  if (state.version !== 1 || state.net !== ctx.net) { ctx.log({ label: 'withdraw', error: `state file is not a v1 ${ctx.net} run state` }); return EXIT.refused; }
  if (state.ownerAddress !== ctx.keys.owner.address) { ctx.log({ label: 'withdraw', error: 'state owner differs from the owner key in the secrets file' }); return EXIT.refused; }
  const live = new AgentLeash(paramsFromState(state), ctx.provider);
  if (live.tokenAddress !== state.leash) { ctx.log({ label: 'withdraw', error: `rebuilt leash ${live.tokenAddress} != saved ${state.leash}` }); return EXIT.refused; }

  let utxos: SpendableUtxo[] = [];
  const polls = Math.max(1, Math.min(ctx.polls ?? 10, 10));
  for (let i = 0; i < polls; i++) {
    const u = await live.getUtxos();
    utxos = [...(u.state ? [u.state] : []), ...u.stray, ...u.invalid];
    if (utxos.length) break;
    await sleep(ctx.pollMs ?? 3000);
  }
  const close = (reason: string, withdrawTxid?: string) => {
    Object.assign(state, { closed: true, phase: 'closed', closeReason: reason, ...(withdrawTxid ? { withdrawTxid } : {}) });
    if (ctx.broadcast) saveStateAtomic(ctx.statePath, state);
    ctx.log({ label: ctx.broadcast ? 'run closed' : 'run would be closed (dry run)', reason, withdrawTxid });
  };
  if (!utxos.length) {
    // Jules review 17.10: an empty leash is closed only on positive evidence. Agent payments always keep a
    // state coin on the leash, so with the genesis on the network only an owner withdraw empties it; a
    // lagging server shows an empty leash too, and closing then would forget the funds.
    const known = await txKnown(ctx, state.plannedGenesisTxid);
    if (known === undefined) { ctx.log({ label: 'withdraw', error: 'leash empty but the genesis status is unknown (server error); retry later' }); return EXIT.fundsMayRemain; }
    if (!known) {
      if (state.genesisTxid) {
        ctx.log({ label: 'withdraw', error: `the node accepted the genesis ${state.genesisTxid} earlier but the server does not know it now; not closing, check ${state.leash} in an explorer and retry` });
        return EXIT.fundsMayRemain;
      }
      close('genesis never reached the network: nothing on the leash');
      return EXIT.ok;
    }
    for (const t of state.withdrawAttempts ?? []) {
      const k = await txKnown(ctx, t);
      if (k === undefined) { ctx.log({ label: 'withdraw', error: `leash empty but the status of withdraw ${t} is unknown (server error); retry later` }); return EXIT.fundsMayRemain; }
      if (k) { close('leash empty: already swept by an earlier withdraw', t); return EXIT.ok; }
    }
    ctx.log({ label: 'withdraw', error: `leash empty while the genesis is on the network and none of this run's withdraw transactions is known: lagging server or swept by another tool; not closing, check ${state.leash} in an explorer and retry` });
    return EXIT.fundsMayRemain;
  }
  const own = (await ctx.provider.getUtxos(ctx.keys.owner.address)).filter((u) => !u.token).sort((a, b) => (b.satoshis > a.satoshis ? 1 : -1))[0];
  if (!own) { ctx.log({ label: 'withdraw', error: 'owner has no plain coin for the owner path; send any coin to the owner address and retry' }); return EXIT.fundsMayRemain; }
  const ownerPkh = hexToBin(ctx.keys.owner.pkhHex);
  let tb: TransactionBuilder;
  try {
    tb = live.buildWithdraw({
      contractUtxos: utxos, ownerUtxo: own, ownerUnlocker: new SignatureTemplate(hexToBin(ctx.keys.owner.privHex)).unlockP2PKH(),
      ownerAddress: ctx.keys.owner.address, ownerTokenAddress: addressOfPkh(ownerPkh, ctx.net, true),
    });
  } catch (e: any) { ctx.log({ label: 'withdraw', error: `build failed: ${e?.message ?? e}` }); return EXIT.fundsMayRemain; }
  const fee = feeOf(tb);
  if (fee > ctx.caps.withdrawFeeMax) { ctx.log({ label: 'withdraw', error: `fee ${fee} > cap ${ctx.caps.withdrawFeeMax}` }); return EXIT.fundsMayRemain; }
  const ownerLockHex = binToHex(p2pkhLock(ownerPkh));
  if (tb.outputs.some((o) => binToHex(typeof o.to === 'string' ? lockingBytecodeOf(o.to) : o.to) !== ownerLockHex)) {
    ctx.log({ label: 'withdraw', error: 'withdraw output not to the owner' }); return EXIT.fundsMayRemain;
  }
  if (ctx.broadcast) {
    // recorded before sending: if the response is lost, a later withdraw recognises the sweep by this txid
    state.withdrawAttempts = [...(state.withdrawAttempts ?? []), plannedTxid(tb)];
    saveStateAtomic(ctx.statePath, state);
  }
  const r = await send(ctx, 'owner withdraws everything', tb, { leash: state.leash, swept: utxos.reduce((s, u) => s + u.satoshis, 0n) });
  if (!ctx.broadcast) return EXIT.ok;
  if (!r.txid) return EXIT.fundsMayRemain;
  close('withdrawn', r.txid);
  return EXIT.ok;
}

