import './style.css';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { TransactionBuilder } from 'cashscript';
import qrcode from 'qrcode-generator';
import {
  ATTACKS, AgentLeash, buildAttack, buildGenesis, localReason, pkhOfPrivateKey, placeholderBytes, withAutoFee,
  type AgentEvent, type AttackKind, type FailoverProvider, type LeashParams,
} from '../../src/browser.js';
import { ALLOW_MAINNET, NETWORKS, initialNetwork, type NetConfig, type NetName } from './config.js';
import { addressOf, journal, lockOf, providerFor, stateNow, type JournalRow } from './chain.js';
import { browserOwner, startWizard, type Owner, type OwnerCoin, type WizardSession } from './owner.js';
import { BRIEF_GOAL, TOOLS, callTool, makePaywall, runAutopilot, type FlowEvent } from './tools.js';
import {
  consumePendingAgentKey, descriptorOf, forget, fromShareHash, leashOf, loadAll, pendingAgentKey, saveOne, shareHash, type LeashDescriptor,
} from './store.js';
import { PUBLIC_DEMO } from './demo.js';

// ---------- tiny DOM helpers (textContent only: nothing from the chain or a link is parsed as HTML) ----------
type Child = Node | string | number | bigint | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fill = (el: HTMLElement, ...kids: Child[]) => { el.replaceChildren(); for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c)); };
const sats = (n: bigint | number) => `${Number(n).toLocaleString('en-US')} sats`;
const short = (s: string, a = 10, b = 6) => (s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s);
const errText = (e: any) => String(e?.message ?? e).split('\n')[0];
/** Verbatim node refusal: every line of the Electrum/node message except an echoed transaction hex. */
const nodeText = (e: any) => String(e?.originalError ?? e?.message ?? e).split('\n').map((l) => l.trim())
  .filter((l) => l && !/^[0-9a-f]{120,}$/i.test(l)).join(' ').slice(0, 400);

// ---------- state ----------
let net: NetConfig = NETWORKS[initialNetwork()];
let provider: FailoverProvider = providerFor(net);
let current: { desc: LeashDescriptor; leash: AgentLeash } | undefined;
let owner: Owner | undefined;
let wizard: WizardSession | undefined;
let refreshTimer: number | undefined;
let busy = false;

function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  console.info(`[toast:${kind}] ${msg}`);
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : 5000);
}

function txLink(txid: string, label = short(txid, 8, 8)) {
  return h('a', { href: net.explorerTx(txid), target: '_blank', rel: 'noopener', class: 'mono' }, label);
}
function addrLink(addr: string) {
  return h('a', { href: net.explorerAddr(addr), target: '_blank', rel: 'noopener', class: 'mono' }, short(addr, 18, 6));
}
function copyBtn(text: string, label = 'Copy') {
  return h('button', { class: 'btn ghost sm', onclick: async () => { await navigator.clipboard.writeText(text); toast('Copied', 'ok'); } }, label);
}

async function guard<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (busy) { toast('One thing at a time: wait for the current step', 'info'); return; }
  busy = true;
  document.body.classList.add('busy');
  try { return await fn(); }
  catch (e) { toast(`${label}: ${errText(e)}`, 'err'); console.error(e); }
  finally { busy = false; document.body.classList.remove('busy'); }
}

// ---------- network switch ----------
function renderNet() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-net]')) {
    b.classList.toggle('active', b.dataset.net === net.name);
    if (b.dataset.net === 'mainnet' && !ALLOW_MAINNET) b.title = 'Opens after the contract freeze (31.10). Prototype, unaudited.';
  }
  document.body.dataset.net = net.name;
  fill($('net-note'), net.name === 'chipnet'
    ? h('span', {}, 'Chipnet: free test coins, real transactions, real network rules. ', net.faucet ? h('a', { href: net.faucet, target: '_blank', rel: 'noopener' }, 'Get test coins') : '')
    : h('span', {}, `Mainnet: real BCH. Prototype, unaudited. Caps: fund ≤ ${sats(net.maxFund)}, limit ≤ ${sats(net.maxLimit)}.`));
}
function switchNet(name: NetName) {
  if (name === 'mainnet' && !ALLOW_MAINNET) {
    toast('Mainnet opens after the contract freeze and a capped mainnet run. Until then: chipnet.', 'info');
    return;
  }
  if (name === net.name) return;
  owner?.disconnect(); owner = undefined; wizard?.cancel(); wizard = undefined;
  net = NETWORKS[name];
  provider = providerFor(net);
  const u = new URL(location.href); u.searchParams.set('net', name); history.replaceState(null, '', u);
  current = undefined;
  $<HTMLInputElement>('payee-1').value = net.demoToolPayee ?? '';
  renderNet(); renderOwner(); renderLeashPicker(); selectDefault();
}

// ---------- leash picker ----------
function allDescriptors(): LeashDescriptor[] {
  const list: LeashDescriptor[] = [];
  const demo = PUBLIC_DEMO[net.name];
  if (demo) list.push(demo);
  for (const d of loadAll()) if (d.net === net.name && !list.some((x) => x.id === d.id)) list.push(d);
  return list;
}
function renderLeashPicker() {
  const sel = $<HTMLSelectElement>('leash-select');
  sel.replaceChildren();
  for (const d of allDescriptors()) sel.append(h('option', { value: d.id, selected: current?.desc.id === d.id }, d.publicDemo ? `★ ${d.label}` : d.label));
  if (current && !allDescriptors().some((d) => d.id === current!.desc.id)) sel.append(h('option', { value: current.desc.id, selected: true }, `${current.desc.label} (from link)`));
  if (!sel.options.length) sel.append(h('option', { value: '' }, 'No leash yet: create one below'));
}
function select(d: LeashDescriptor) {
  try {
    current = { desc: d, leash: leashOf(d, provider) };
  } catch (e) { toast(`Cannot open leash: ${errText(e)}`, 'err'); return; }
  snap = undefined;
  renderLeashPicker();
  renderLeash(undefined);
  void refresh();
}
function selectDefault() {
  const fromLink = fromShareHash(location.hash);
  if (fromLink && fromLink.net === net.name) { select(fromLink); return; }
  const list = allDescriptors();
  if (list.length) select(list[0]); else { current = undefined; renderLeash(undefined); }
}

// ---------- leash view ----------
interface Snapshot { utxo?: Awaited<ReturnType<typeof stateNow>>['utxo']; state?: { elapsed: bigint; spent: bigint }; age: bigint; tip: number; stray: number }
let snap: Snapshot | undefined;

async function refresh() {
  if (!current) return;
  const mine = current;
  clearTimeout(refreshTimer);
  $('leash-status').textContent = 'reading the chain…';
  try {
    const s = await stateNow(mine.leash);
    if (current !== mine) return;
    snap = s;
    renderLeash(s);
    $('leash-status').textContent = `block ${s.tip.toLocaleString('en-US')} · updated ${new Date().toLocaleTimeString()}`;
    void renderJournal(mine);
  } catch (e) {
    $('leash-status').textContent = `chain read failed: ${errText(e)} (retrying)`;
  }
  refreshTimer = window.setTimeout(() => { if (!document.hidden) void refresh(); }, 30_000);
}

function renderLeash(s: Snapshot | undefined) {
  const box = $('leash-card');
  if (!current) { fill(box, h('p', { class: 'muted' }, 'Pick a leash above or create your own.')); return; }
  const { desc, leash } = current;
  const p = leash.params;
  const st = s?.state;
  const spent = st?.spent ?? 0n;
  const pct = Math.min(100, Number((spent * 1000n) / p.limit) / 10);
  const effElapsed = st ? st.elapsed + (s?.age ?? 0n) : 0n;
  const resetsNow = st ? effElapsed >= p.period : false;
  const blocksLeft = st && !resetsNow ? p.period - effElapsed : 0n;
  const left = resetsNow ? p.limit : p.limit - spent;
  const allow = p.allow.map((a) => addressOf(a, net));
  fill(box,
    h('div', { class: 'leash-head' },
      h('div', {},
        h('div', { class: 'eyebrow' }, desc.publicDemo ? 'Public demo leash · its agent key is published on purpose' : 'Your leash'),
        h('h3', {}, desc.label)),
      h('div', { class: 'row gap' }, copyBtn(location.origin + location.pathname + `?net=${net.name}` + shareHash(desc), 'Share link'),
        !desc.publicDemo ? h('button', { class: 'btn ghost sm', onclick: () => { if (confirm('Forget this leash in this browser? Funds stay on chain.')) { forget(desc.id); current = undefined; renderLeashPicker(); selectDefault(); } } }, 'Forget') : null)),
    !s ? h('p', { class: 'muted' }, 'Loading…')
      : !s.utxo ? h('div', { class: 'callout' }, 'No state coin on this address: the leash is closed (withdrawn) or the genesis is not seen yet.')
        : h('div', { class: 'gauges' },
          h('div', { class: 'gauge' },
            h('div', { class: 'gauge-top' }, h('span', {}, 'Spent in this window'), h('b', {}, `${sats(resetsNow ? 0n : spent)} / ${sats(p.limit)}`)),
            h('div', { class: 'bar' }, h('div', { class: `fill ${pct > 85 && !resetsNow ? 'hot' : ''}`, style: `width:${resetsNow ? 0 : pct}%` })),
            h('div', { class: 'gauge-foot' }, resetsNow
              ? 'Window has expired: the next payment opens a fresh one.'
              : `${sats(left)} left · window resets after ~${blocksLeft} more block${blocksLeft === 1n ? '' : 's'} (~${Number(blocksLeft) * 10} min)`)),
          h('div', { class: 'stats' },
            stat('Balance', sats(s.utxo.satoshis)),
            stat('Window', `${p.period} blocks`),
            stat('Max fee / payment', sats(p.maxFee)),
            stat('State coin age', `${s.age} block${s.age === 1n ? '' : 's'}`))),
    h('details', { class: 'rules' },
      h('summary', {}, 'Rules enforced by the network'),
      h('ul', {},
        h('li', {}, `Agent key hash ${short(binToHex(p.agentPkh), 8, 6)} may spend at most ${sats(p.limit)} per ${p.period} blocks, fees included.`),
        h('li', {}, 'Only to: ', ...allow.flatMap((a, i) => [i ? ', ' : '', addrLink(a)])),
        h('li', {}, `Miner fee at most ${sats(p.maxFee)} per payment; every payment carries an OP_RETURN receipt bound to the HTTP request.`),
        h('li', {}, 'Owner (', addrLink(addressOf(p.ownerLock, net)), ') can top up or take everything back at any time, without the agent key.'),
        h('li', {}, 'Contract: ', addrLink(leash.tokenAddress), ' · state NFT category ', h('span', { class: 'mono' }, short(p.stateCategory, 8, 8))))));
  renderAgent();
  renderOwnerActions();
}
const stat = (k: string, v: string) => h('div', { class: 'stat' }, h('span', {}, k), h('b', {}, v));

async function renderJournal(mine: NonNullable<typeof current>) {
  const box = $('journal');
  let rows: JournalRow[];
  try { rows = await journal(mine.leash, net); } catch (e) { fill(box, h('p', { class: 'muted' }, `journal unavailable: ${errText(e)}`)); return; }
  if (current !== mine) return;
  if (!rows.length) { fill(box, h('p', { class: 'muted' }, 'No transactions yet.')); return; }
  const label: Record<string, string> = { genesis: 'Created', payment: 'Agent paid', topup: 'Owner topped up', withdraw: 'Owner withdrew', other: 'Other' };
  fill(box, h('table', { class: 'journal' },
    h('thead', {}, h('tr', {}, h('th', {}, 'What'), h('th', {}, 'Amount'), h('th', {}, 'Fee'), h('th', {}, 'To'), h('th', {}, 'Window after'), h('th', {}, 'Receipt'), h('th', {}, 'Tx'))),
    h('tbody', {}, ...rows.slice().reverse().map((r) => h('tr', { class: r.kind },
      h('td', {}, h('span', { class: `tag ${r.kind}` }, label[r.kind]), r.height <= 0 ? h('span', { class: 'pending' }, ' unconfirmed') : ''),
      h('td', {}, r.amount !== undefined ? sats(r.amount) : '—'),
      h('td', {}, r.fee !== undefined ? sats(r.fee) : '—'),
      h('td', {}, r.payee ? addrLink(r.payee) : '—'),
      h('td', {}, r.state ? `${sats(r.state.spent)} · ${r.state.elapsed}/${mine.leash.params.period} blk` : '—'),
      h('td', { class: 'mono' }, r.receipt ? short(r.receipt, 6, 4) : '—'),
      h('td', {}, txLink(r.txid)))))));
}

// ---------- agent console ----------
function agentKeyOf(desc: LeashDescriptor): Uint8Array | undefined {
  return desc.agentPriv ? hexToBin(desc.agentPriv) : undefined;
}
function renderAgent() {
  const box = $('agent-tools');
  if (!current) { fill(box); return; }
  const key = agentKeyOf(current.desc);
  const payee = net.demoToolPayee;
  if (!key) { fill(box, h('p', { class: 'muted' }, 'This browser does not hold the agent key of this leash (watch-only). Use the public demo leash or create your own.')); return; }
  if (!payee) { fill(box, h('p', { class: 'muted' }, 'Demo tools are not configured on this network.')); return; }
  const onList = current.leash.params.allow.some((a) => binToHex(a) === binToHex(lockOf(payee)));
  fill(box,
    h('div', { class: 'autopilot' },
      h('div', {},
        h('b', {}, 'Let the agent work on its own'),
        h('small', { class: 'muted' }, `Goal: "${BRIEF_GOAL}" The agent plans, gets 402 for every tool, pays from the leash and reports. `,
          'Scripted planner here (a public page holds no model key); ', h('code', {}, 'npm run agent'), ' runs the same loop with any OpenAI-compatible LLM.')),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn primary', id: 'autopilot-brief', onclick: () => autopilot(false) }, 'Run the agent (3 tools, ~5 200 sats)'),
        h('button', { class: 'btn ghost', id: 'autopilot-full', onclick: () => autopilot(true) }, 'Run until the leash says no'))),
    h('div', { class: 'eyebrow tools-or' }, 'or buy one tool by hand'),
    h('div', { class: 'tools' }, ...TOOLS.map((t) => h('button', { class: 'tool', onclick: () => runTool(t) },
      h('b', {}, t.title), h('span', { class: 'price' }, sats(t.price)), h('small', {}, t.description)))),
    !onList ? h('div', { class: 'callout warn' }, 'The demo tool payee is not on this leash\'s allow-list: the agent will refuse to pay it (that is the leash working).') : null);
}

async function runTool(tool: (typeof TOOLS)[number]) {
  if (!current) return;
  const { leash, desc } = current;
  const key = agentKeyOf(desc)!;
  const log = $('flow');
  log.replaceChildren();
  const add = (e: FlowEvent) => {
    const row = h('div', { class: `flow-row ${e.step}` }, h('span', { class: 'dot' }), h('div', {}, e.text,
      e.step === 'paid' && e.txid ? h('div', {}, 'payment tx ', txLink(e.txid)) : null,
      e.step === 'paid' && e.body ? h('pre', {}, e.body) : null));
    log.append(row);
  };
  await guard('Agent', async () => {
    const paywall = makePaywall(net, provider, net.demoToolPayee!);
    await callTool({ tool, leash, agentPrivateKey: key, net, paywall, maxPrice: 5_000n, on: add });
    await refresh();
  });
}

async function autopilot(untilRefused: boolean) {
  if (!current) return;
  const { leash, desc } = current;
  const key = agentKeyOf(desc)!;
  const log = $('flow');
  log.replaceChildren();
  const byWho: Record<string, string> = { sdk: 'refused before signing (agent SDK)', network: 'refused by the network', server: 'refused by the tool', agent: 'refused by the agent' };
  const add = (e: AgentEvent) => {
    let cls = 'request', text = e.text;
    if (e.kind === 'plan') { cls = 'plan'; text = `plan #${e.step}: ${e.text}${e.budget ? ` · window ${sats(e.budget.spent)} of ${sats(e.budget.limit)} spent` : ''}`; }
    if (e.kind === 'challenge') { cls = 'challenge'; text = `tool ← ${e.text.replace(/, nonce [0-9a-f]+$/, '')}`; }
    if (e.kind === 'paid') cls = 'paid';
    if (e.kind === 'refused') { cls = 'refused'; text = `${byWho[e.by ?? 'sdk']}: ${e.reason}`; }
    if (e.kind === 'failed') cls = 'refused';
    if (e.kind === 'finish') { cls = 'finish'; text = `agent's answer: ${e.text}`; }
    if (e.kind === 'start') { cls = 'plan'; text = untilRefused ? 'goal: brief me on BCH, then keep watching the chain tip (until the leash says no)' : `goal: ${BRIEF_GOAL}`; }
    log.append(h('div', { class: `flow-row ${cls}` }, h('span', { class: 'dot' }), h('div', {}, text,
      e.kind === 'paid' && e.txid ? h('div', {}, 'payment tx ', txLink(e.txid)) : null,
      e.kind === 'paid' && e.body ? h('pre', {}, e.body) : null)));
    if (e.kind === 'paid') void refresh();
  };
  await guard('Agent', async () => {
    const paywall = makePaywall(net, provider, net.demoToolPayee!);
    const r = await runAutopilot({ leash, agentPrivateKey: key, net, paywall, untilRefused, on: add });
    const paidN = r.calls.filter((c) => c.outcome === 'paid').length;
    if (!paidN && r.calls.some((c) => c.by === 'sdk' && /^limit exceeded/.test(c.reason ?? ''))) {
      log.append(h('div', { class: 'callout' }, desc.publicDemo
        ? 'That refusal is the leash at work: other visitors have used this window of the public demo leash. It reopens after the blocks shown above. Meanwhile: "Try to break it" below, or create your own leash with free chipnet coins.'
        : 'That refusal is the leash at work: this window is used up. It reopens after the blocks shown above.'));
    }
    toast(`Agent done: ${paidN} paid call(s)`, paidN ? 'ok' : 'info');
    await refresh();
  });
}

// ---------- try to break it ----------
function renderAttacks() {
  const box = $('attacks');
  fill(box, ...(Object.keys(ATTACKS) as AttackKind[]).map((k) => h('div', { class: 'attack', id: `attack-${k}` },
    h('b', {}, ATTACKS[k].title),
    h('p', {}, ATTACKS[k].story),
    h('button', { class: 'btn danger sm', onclick: () => runAttack(k) }, 'Sign and broadcast'),
    h('div', { class: 'attack-out' }))));
}
async function runAttack(kind: AttackKind) {
  if (!current) return toast('Pick a leash first', 'info');
  const key = agentKeyOf(current.desc);
  if (!key) return toast('This browser does not hold the agent key of this leash', 'info');
  const out = document.querySelector<HTMLElement>(`#attack-${kind} .attack-out`)!;
  fill(out, h('span', { class: 'muted' }, 'signing with the agent key and broadcasting…'));
  await guard('Attack', async () => {
    const s = await stateNow(current!.leash);
    if (!s.utxo) throw new Error('no state coin: the leash is closed');
    let a;
    try { a = buildAttack(kind, { leash: current!.leash, stateUtxo: s.utxo, agentPrivateKey: key, realAge: s.age }); }
    catch (e) { fill(out, h('span', { class: 'muted' }, errText(e))); return; }
    const local = localReason(a.builder);
    const hex = a.builder.build();
    try {
      const txid = await provider.sendRawTransaction(hex);
      fill(out, h('div', { class: 'verdict bad' }, 'ACCEPTED: this must never happen. Please report: ', txLink(txid)));
    } catch (e) {
      fill(out,
        h('div', { class: 'verdict ok' }, '✕ Rejected by the network'),
        h('div', { class: 'quote mono' }, nodeText(e)),
        h('div', { class: 'muted small' }, local ? `Contract rule that failed: "${local}"` : `Refused before the script runs: ${ATTACKS[kind].rule}`));
    }
  });
}

// ---------- owner: connect ----------
function renderOwner() {
  const box = $('owner-box');
  if (owner) {
    fill(box,
      h('div', { class: 'connected' },
        h('div', {}, h('div', { class: 'eyebrow' }, owner.kind === 'wizard' ? 'Connected over WizardConnect' : 'Browser key (chipnet only)'),
          h('b', {}, owner.label), h('div', { class: 'mono small' }, owner.address, ' ', copyBtn(owner.address))),
        h('button', { class: 'btn ghost sm', onclick: () => { owner?.disconnect(); owner = undefined; renderOwner(); renderOwnerActions(); } }, 'Disconnect')),
      h('div', { id: 'owner-balance', class: 'muted small' }, 'checking balance…'));
    void showOwnerBalance();
    $('create-form').classList.remove('disabled');
    return;
  }
  $('create-form').classList.add('disabled');
  fill(box,
    h('div', { class: 'tabs' },
      h('button', { class: 'tab active', id: 'tab-wc', onclick: () => showWizard() }, 'WizardConnect wallet'),
      net.burnerOwner ? h('button', { class: 'tab', id: 'tab-browser', onclick: () => useBrowserOwner() }, 'Browser key (chipnet)') : null),
    h('div', { id: 'wc-pane' }, h('button', { class: 'btn primary', onclick: () => showWizard() }, 'Show connection code')));
}
async function showOwnerBalance() {
  if (!owner) return;
  try {
    const coins = await owner.coins();
    const total = coins.reduce((s, c) => s + c.utxo.satoshis, 0n);
    const el = document.getElementById('owner-balance');
    if (el) fill(el, `${sats(total)} in ${coins.length} coin${coins.length === 1 ? '' : 's'}`, total === 0n && net.faucet ? h('span', {}, ' · ', h('a', { href: net.faucet, target: '_blank', rel: 'noopener' }, 'get chipnet coins'), ' to ', h('span', { class: 'mono' }, short(owner.address, 14, 6))) : '');
  } catch (e) { const el = document.getElementById('owner-balance'); if (el) el.textContent = `balance unavailable: ${errText(e)}`; }
}
function showWizard() {
  wizard?.cancel();
  const pane = $('wc-pane');
  document.getElementById('tab-wc')?.classList.add('active');
  document.getElementById('tab-browser')?.classList.remove('active');
  const status = h('div', { class: 'muted small' }, 'connecting to the relay…');
  wizard = startWizard(net, (s) => { status.textContent = `relay: ${s}`; });
  const q = qrcode(0, 'L');
  q.addData(wizard.qrUri);
  q.make();
  const qr = h('div', { class: 'qr' });
  qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  fill(pane,
    h('div', { class: 'wc' },
      qr,
      h('div', {},
        h('ol', { class: 'steps' },
          h('li', {}, h('b', {}, 'Cashonize (web): '), 'open ', h('a', { href: 'https://cashonize.com', target: '_blank', rel: 'noopener' }, 'cashonize.com'), net.name === 'chipnet' ? ' on chipnet' : '', ', WizardConnect, paste the code.'),
          h('li', {}, h('b', {}, 'Paytaca: '), net.name === 'chipnet' ? 'Settings → Use Chipnet Network, then ' : '', 'Apps → WizardConnect, scan or paste.'),
          h('li', {}, h('b', {}, 'Selene: '), 'scan the code with the WizardConnect scanner.')),
        h('div', { class: 'row gap' }, h('input', { id: 'wc-uri', class: 'input mono small', readonly: true, value: wizard.uri, onfocus: (e: Event) => (e.target as HTMLInputElement).select() }), copyBtn(wizard.uri, 'Copy')),
        status)));
  wizard.ready.then((o) => { owner = o; wizard = undefined; toast(`${o.label} connected`, 'ok'); renderOwner(); renderOwnerActions(); })
    .catch((e) => { status.textContent = errText(e); toast(errText(e), 'err'); });
}
function useBrowserOwner() {
  wizard?.cancel(); wizard = undefined;
  owner = browserOwner(net);
  renderOwner(); renderOwnerActions();
}

// ---------- owner: create ----------
function readPayees(): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const el of document.querySelectorAll<HTMLInputElement>('.payee')) {
    const v = el.value.trim();
    if (!v) continue;
    const full = v.includes(':') ? v : `${net.prefix}:${v}`;
    if (!full.startsWith(net.prefix + ':')) throw new Error(`payee ${short(v)} is not a ${net.name} address`);
    out.push(lockOf(full));
  }
  if (!out.length) throw new Error('add at least one allowed payee');
  return out;
}
const num = (id: string) => { const v = $<HTMLInputElement>(id).value.trim(); if (!/^\d+$/.test(v)) throw new Error(`${id.replace('f-', '')}: whole number expected`); return BigInt(v); };

async function broadcast(hex: string): Promise<string> { return provider.sendRawTransaction(hex); }

async function createLeash() {
  if (!owner) return toast('Connect the owner wallet first', 'info');
  await guard('Create', async () => {
    const o = owner!;
    const limit = num('f-limit'), period = num('f-period'), maxFee = num('f-maxfee'), fund = num('f-fund');
    if (fund > net.maxFund) throw new Error(`fund above the ${net.name} cap (${sats(net.maxFund)})`);
    if (limit > net.maxLimit) throw new Error(`limit above the ${net.name} cap (${sats(net.maxLimit)})`);
    const label = $<HTMLInputElement>('f-label').value.trim().slice(0, 40) || 'My agent';
    const agentPriv = pendingAgentKey();
    const base: Omit<LeashParams, 'stateCategory'> = { agentPkh: pkhOfPrivateKey(agentPriv), ownerLock: o.lock, allow: readPayees(), limit, period, maxFee };
    // dry run of the rules (throws on a bad parameter before anything is signed)
    new AgentLeash({ ...base, stateCategory: '00'.repeat(32) }, provider);
    const progress = $('create-progress');
    const step = (t: string) => progress.append(h('div', { class: 'flow-row' }, h('span', { class: 'dot' }), t));
    progress.replaceChildren();

    const coins = await o.coins();
    let gcoin: OwnerCoin | undefined = coins.find((c) => c.utxo.vout === 0 && c.utxo.satoshis >= fund + 2_000n);
    if (!gcoin) {
      const need = fund + 3_000n;
      const pick: OwnerCoin[] = [];
      let total = 0n;
      for (const c of [...coins].sort((a, b) => (b.utxo.satoshis > a.utxo.satoshis ? 1 : -1))) { pick.push(c); total += c.utxo.satoshis; if (total >= need) break; }
      if (total < need) throw new Error(`owner has ${sats(total)}, needs about ${sats(need)}${net.faucet ? ' (get chipnet coins from the faucet)' : ''}`);
      step(`Step 1/2: preparing a coin at output 0 (CashTokens genesis rule), ${pick.length} input(s)…`);
      const unlockers = pick.map((c) => o.unlocker(c));
      const { builder } = withAutoFee((fee) => {
        const tb = new TransactionBuilder({ provider });
        pick.forEach((c, i) => tb.addInput(c.utxo, unlockers[i]));
        return tb.addOutput({ to: o.address, amount: total - fee });
      }, 1, 5n, placeholderBytes(unlockers));
      const hex = await o.finalize(builder, pick.map((coin, index) => ({ index, coin })), 'AgentLeash: prepare a coin (send to yourself)');
      const txid = await broadcast(hex);
      step(`prepared: ${txid}`);
      const dec = decodeTransaction(hexToBin(hex));
      if (typeof dec === 'string') throw new Error(dec);
      const value = dec.outputs[0].valueSatoshis;
      gcoin = { utxo: { txid, vout: 0, satoshis: value, lockingBytecode: binToHex(o.lock) } as any, path: ['receive', 0] };
    }
    step('Step 2/2: genesis, the state NFT (0, 0) and the funds go to the covenant…');
    const { leash, builder } = buildGenesis({ provider, ownerUtxo: gcoin.utxo, ownerUnlocker: o.unlocker(gcoin), ownerAddress: o.address, params: base, fund });
    const hex = await o.finalize(builder, [{ index: 0, coin: gcoin }], `AgentLeash: create a leash, ${sats(limit)} per ${period} blocks`);
    const txid = await broadcast(hex);
    const desc = descriptorOf({ net: net.name, label, params: leash.params, agentPriv, genesisTxid: txid });
    saveOne(desc);
    consumePendingAgentKey();
    step(`created: ${txid}`);
    toast('Leash created', 'ok');
    select(desc);
    document.getElementById('console')?.scrollIntoView({ behavior: 'smooth' });
  });
}

// ---------- owner: top up / withdraw ----------
function renderOwnerActions() {
  const box = $('owner-actions');
  if (!current) { fill(box); return; }
  const isOwner = owner && binToHex(owner.lock) === binToHex(current.leash.params.ownerLock);
  if (!isOwner) {
    fill(box, h('p', { class: 'muted small' }, current.desc.publicDemo
      ? 'Owner controls of the public demo leash stay with its owner. Create your own leash below to try top-up and withdraw.'
      : 'Connect the owner wallet of this leash to top up or withdraw.'));
    return;
  }
  fill(box,
    h('div', { class: 'row gap wrap' },
      h('input', { id: 'topup-amt', class: 'input sm', value: '20000', inputmode: 'numeric' }),
      h('button', { class: 'btn', onclick: () => topUp() }, 'Top up'),
      h('button', { class: 'btn danger', onclick: () => withdraw() }, 'Withdraw everything (close the leash)')),
    h('p', { class: 'muted small' }, 'The owner path needs one coin on ', h('span', { class: 'mono' }, short(owner!.address, 14, 6)), ' (the owner address). The agent key is not needed.'));
}
async function ownerCoin(min: bigint): Promise<OwnerCoin> {
  const coins = (await owner!.coins()).filter((c) => c.utxo.lockingBytecode === binToHex(owner!.lock) && c.utxo.satoshis >= min);
  if (!coins.length) throw new Error(`the owner path needs a coin of at least ${sats(min)} on the owner address ${short(owner!.address, 14, 6)}; send some there first`);
  return coins.sort((a, b) => (b.utxo.satoshis > a.utxo.satoshis ? 1 : -1))[0];
}
async function topUp() {
  await guard('Top up', async () => {
    const amount = num('topup-amt');
    const { state } = await current!.leash.getUtxos();
    if (!state) throw new Error('no state coin');
    const coin = await ownerCoin(amount + 1_500n);
    const tb = current!.leash.buildTopUp({ stateUtxo: state, ownerUtxo: coin.utxo, ownerUnlocker: owner!.unlocker(coin), ownerAddress: owner!.address, amount });
    const txid = await broadcast(await owner!.finalize(tb, [{ index: 1, coin }], `AgentLeash: top up ${sats(amount)}`));
    toast(`Topped up: ${short(txid)}`, 'ok');
    await refresh();
  });
}
async function withdraw() {
  if (!confirm('Withdraw everything to the owner and burn the state NFT? The agent can no longer pay.')) return;
  await guard('Withdraw', async () => {
    const { state, stray } = await current!.leash.getUtxos();
    const utxos = [state, ...stray].filter(Boolean) as NonNullable<typeof state>[];
    if (!utxos.length) throw new Error('nothing to withdraw');
    const coin = await ownerCoin(1_000n);
    const tb = current!.leash.buildWithdraw({ contractUtxos: utxos, ownerUtxo: coin.utxo, ownerUnlocker: owner!.unlocker(coin), ownerAddress: owner!.address, ownerTokenAddress: owner!.tokenAddress });
    const txid = await broadcast(await owner!.finalize(tb, [{ index: 0, coin }], 'AgentLeash: withdraw everything and close the leash'));
    toast(`Withdrawn: ${short(txid)}`, 'ok');
    await refresh();
  });
}

// ---------- boot ----------
function boot() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-net]')) b.addEventListener('click', () => switchNet(b.dataset.net as NetName));
  $('leash-select').addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    const d = allDescriptors().find((x) => x.id === id);
    if (d) { history.replaceState(null, '', location.pathname + location.search); select(d); }
  });
  $('refresh').addEventListener('click', () => void refresh());
  $('create-btn').addEventListener('click', () => void createLeash());
  const payeeFirst = $<HTMLInputElement>('payee-1');
  if (net.demoToolPayee) payeeFirst.value = net.demoToolPayee;
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  renderNet(); renderOwner(); renderAttacks(); renderLeashPicker(); selectDefault();
}
boot();
