// Paytaca compatibility without a phone: run Paytaca's OWN WizardConnect signing code on AgentLeash requests.
//
// Paytaca (paytaca-app, github.com/paytaca/paytaca-app) signs WizardConnect requests in two files:
//   src/wallet/wizardconnect/service.js  -> signRequest(): hydrate relay JSON, derive keys from inputPaths
//   src/wallet/bch-sign.js               -> signBchTransaction(): P2PKH 0x61 Schnorr, contract placeholders
// The repo has no SPDX licence, so nothing is vendored: the files are downloaded at a pinned commit into
// local/paytaca/<commit>/ (gitignored), their sha256 is printed, and only the imports that need the app
// are rewritten (mnemonic storage -> fixed test mnemonic; bip39 -> sha512 seed; 'bitauth-libauth-v3' ->
// '@bitauth/libauth' 3.1.0-next.x, the same major Paytaca aliases). The signing code itself runs unchanged.
//
// Offline (default): genesis, top-up and withdraw built by toWizardSignRequest, sent through JSON (what
// the relay carries), signed by Paytaca's signRequest in chipnet mode, verified in the BCH 2026 VM.
// --relay: additionally Paytaca's own getManager() (its adapter + @wizardconnect/wallet manager, chipnet
// xpubs) connects to our dapp over the public Riften relays and answers a withdraw sign request.
//
// Mock UTXOs only: nothing is broadcast, no coins move, the mnemonic is a throwaway test vector.
// What this does NOT cover: Paytaca's UI (pairing screen, approval dialog, chipnet toggle) and the release
// build on a phone — that is the manual step in projects/ASKS_ARTUR.md:
// --phone: dapp side only. Prints a wiz:// URI (also local/paytaca/phone-uri.txt), waits up to 20 min for the
// real Paytaca app (Settings -> Use Chipnet Network; Apps -> WizardConnect -> Paste URL), then sends three
// sign requests (genesis, top-up, withdraw over mock UTXOs: approving them moves nothing) and VM-verifies
// each answer. Results go to scripts/paytaca-phone-log.jsonl.
//
// Usage: npx tsx scripts/paytaca-compat.ts [--relay [--late <s>] | --phone] [--commit <sha>]
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeCashAddress, hash160, secp256k1, deriveHdPrivateNodeChild, generatePrivateKey } from '@bitauth/libauth';
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { MockNetworkProvider, SignatureTemplate, placeholderP2PKHUnlocker, randomUtxo, type SpendableUtxo } from 'cashscript';
import { AgentLeash, buildGenesis, encodeState, p2pkhLock, toWizardSignRequest, verifySigned, type WizardSignPayload } from '../src/index.js';
import { setup, type Key } from '../test/helpers.js';

const args = process.argv.slice(2);
const rawCommit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : 'bfeaefe9c93cc1f9992e78727922e63c37ebd164';
if (!/^[0-9a-f]{7,40}$/i.test(rawCommit)) {
  console.error(`Invalid --commit argument: ${rawCommit}`);
  process.exit(1);
}
const COMMIT = rawCommit.toLowerCase();

const RELAY = args.includes('--relay');
const PHONE = args.includes('--phone');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'local', 'paytaca', COMMIT);
const FILES = { 'bch-sign.mjs': 'src/wallet/bch-sign.js', 'service.mjs': 'src/wallet/wizardconnect/service.js' } as const;

// Expected SHA256 digests for pinned commit bfeaefe9c93cc1f9992e78727922e63c37ebd164
const PINNED_SHA256: Record<string, string> = {
  'src/wallet/bch-sign.js': 'b9a662ec9126e955181e574a3d0ba7bd6143ead383af28ecdab1d4ce4ce4c55e',
  'src/wallet/wizardconnect/service.js': '3d1c2e491eafdb304056a54342bf636f111c1a383cd8a059e19256200aae3968',
};

// BIP39 test vector; the seed is sha512(mnemonic) via the bip39 stub, so it is NOT the BIP39 seed of these words.
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

async function fetchPaytaca(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  for (const [local, remote] of Object.entries(FILES)) {
    const target = join(DIR, local);
    let src: string;
    if (existsSync(target + '.orig')) src = readFileSync(target + '.orig', 'utf8');
    else {
      const url = `https://raw.githubusercontent.com/paytaca/paytaca-app/${COMMIT}/${remote}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      src = await r.text();
      writeFileSync(target + '.orig', src);
    }
    const hash = createHash('sha256').update(src).digest('hex');
    console.log(`paytaca ${COMMIT.slice(0, 8)} ${remote} sha256 ${hash}`);
    if (PINNED_SHA256[remote] && hash !== PINNED_SHA256[remote]) {
      throw new Error(`SHA256 mismatch for ${remote}: expected ${PINNED_SHA256[remote]}, got ${hash}`);
    }
    const rewritten = src
      .replace(/from 'bitauth-libauth-v3'/g, "from '@bitauth/libauth'")
      .replace(/from 'src\/wallet\/index'/g, "from './stub-wallet-index.mjs'")
      .replace(/from 'src\/wallet\/bch-sign'/g, "from './bch-sign.mjs'")
      .replace(/from 'bip39'/g, "from './stub-bip39.mjs'");
    if (/from '(src\/|bitauth-libauth-v3|bip39)/.test(rewritten)) throw new Error(`${remote}: unexpected app import left`);
    writeFileSync(target, rewritten);
  }
  writeFileSync(join(DIR, 'stub-wallet-index.mjs'), `export async function getMnemonic() { return ${JSON.stringify(TEST_MNEMONIC)}; }\n`);
  writeFileSync(join(DIR, 'stub-bip39.mjs'),
    "import { sha512 } from '@bitauth/libauth';\nexport function mnemonicToSeedSync(m) { return sha512.hash(new TextEncoder().encode(m)); }\n");
}

function keyFromPriv(priv: Uint8Array): Key {
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pub);
  const enc = (type: 'p2pkh' | 'p2pkhWithTokens') => {
    const r = encodeCashAddress({ prefix: 'bchtest', type, payload: pkh });
    return typeof r === 'string' ? r : r.address;
  };
  return { priv, pub, pkh, address: enc('p2pkh'), tokenAddress: enc('p2pkhWithTokens'), lock: p2pkhLock(pkh), sig: new SignatureTemplate(priv) };
}

const overRelay = (p: WizardSignPayload): WizardSignPayload => JSON.parse(JSON.stringify(p));

async function main(): Promise<void> {
  if (PHONE) {
    mkdirSync(join(ROOT, 'local', 'paytaca'), { recursive: true });
    await dappRound((uri) => {
      writeFileSync(join(ROOT, 'local', 'paytaca', 'phone-uri.txt'), uri + '\n');
      console.log(`\nPaste this into Paytaca (chipnet) -> Apps -> WizardConnect -> Paste URL:\n${uri}\n`);
    }, 20 * 60_000, join(ROOT, 'scripts', 'paytaca-phone-log.jsonl'));
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
    process.exit(failures ? 1 : 0);
  }
  await fetchPaytaca();
  const svc = await import(pathToFileURL(join(DIR, 'service.mjs')).href);
  svc.setWalletConfig(0, true, 'agentleash-compat');
  const nodes = await svc.ensureHdNodes();
  const owner = keyFromPriv(deriveHdPrivateNodeChild(nodes.hdMain, 0).privateKey);
  console.log(`Paytaca receive/0 (chipnet): ${owner.address}`);
  const sign = (p: WizardSignPayload) => svc.signRequest(overRelay(p)) as Promise<string>;
  const srcOf = (p: WizardSignPayload) => (overRelay(p).transaction as any).sourceOutputs;

  // genesis: CashTokens NFT creation from the owner's P2PKH coin
  {
    const ctx = setup({ ownerLock: owner.lock });
    const ownerUtxo = { ...ctx.addP2pkh(owner, 100_000n), vout: 0 };
    const { builder } = buildGenesis({
      provider: ctx.provider, ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(owner.address), ownerAddress: owner.address,
      params: { agentPkh: ctx.agent.pkh, ownerLock: owner.lock, allow: [ctx.server.lock], limit: 6_000n, period: 3n, maxFee: 2_000n },
      fund: 40_000n,
    });
    const req = toWizardSignRequest(builder, { inputPaths: [[0, 'receive', 0]], userPrompt: 'AgentLeash: create leash' });
    const origTxHex = (req.transaction as any).transaction;
    const v = verifySigned(await sign(req), srcOf(req), origTxHex);
    check('genesis signed by Paytaca signRequest passes the BCH 2026 VM', v === true, v === true ? '' : String(v));
  }
  // top-up: contract input (full unlocking bytecode) + owner P2PKH placeholder at index 1
  {
    const ctx = setup({ ownerLock: owner.lock });
    const state = ctx.addState(10_000n);
    const ownerUtxo = ctx.addP2pkh(owner, 50_000n);
    const tb = ctx.leash.buildTopUp({ stateUtxo: state, ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(owner.address), ownerAddress: owner.address, amount: 20_000n });
    const req = toWizardSignRequest(tb, { inputPaths: [[1, 'receive', 0]], userPrompt: 'AgentLeash: top up' });
    const origTxHex = (req.transaction as any).transaction;
    const v = verifySigned(await sign(req), srcOf(req), origTxHex);
    check('top-up (state NFT input untouched, owner input signed) passes the VM', v === true, v === true ? '' : String(v));
  }
  // withdraw: owner P2PKH at index 0, state contract input after it
  {
    const ctx = setup({ ownerLock: owner.lock });
    const state = ctx.addState(40_000n, { elapsed: 3n, spent: 2_000n });
    const ownerUtxo = ctx.addP2pkh(owner, 5_000n);
    const tb = ctx.leash.buildWithdraw({ contractUtxos: [state], ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(owner.address), ownerAddress: owner.address });
    const req = toWizardSignRequest(tb, { inputPaths: [[0, 'receive', 0]], userPrompt: 'AgentLeash: withdraw' });
    const origTxHex = (req.transaction as any).transaction;
    const v = verifySigned(await sign(req), srcOf(req), origTxHex);
    check('withdraw signed by Paytaca passes the VM', v === true, v === true ? '' : String(v));

    // Negative: a path that names the contract input. Paytaca does not refuse (the relay drops `contract`,
    // the input already has an unlocking bytecode, so neither signing branch runs) and returns the tx with
    // the owner input unsigned. Our side must catch that with verifySigned before broadcasting.
    const bad = overRelay(req);
    (bad as any).inputPaths = [[1, 'receive', 0]];
    let out: string | Error;
    try { out = await svc.signRequest(bad); } catch (e: any) { out = e; }
    const caught = out instanceof Error || verifySigned(out, srcOf(req), origTxHex) !== true;
    check('path at the contract input: owner input stays unsigned and verifySigned rejects it', caught,
      out instanceof Error ? `Paytaca threw: ${out.message.slice(0, 80)}` : 'Paytaca returned a tx, VM rejected it');
  }

  if (RELAY) await relayRound(svc);
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

/** Paytaca's own manager/adapter (getManager) answers our dapp over the public relays. */
async function relayRound(svc: any): Promise<void> {
  const manager = await svc.getManager();
  manager.on('pendingSignRequest', async ({ connectionId, request }: any) => {
    // The app shows an approval dialog here and then calls signRequest + sendSignResponse; we approve.
    try { await svc.sendSignResponse(connectionId, request.sequence, await svc.signRequest(request)); }
    catch (e: any) { await svc.sendSignError(connectionId, request.sequence, String(e?.message ?? e)); }
  });
  // --late <s>: the wallet joins after the dapp's 30 s key-exchange wait has expired, like a person pasting a URI.
  const lateMs = args.includes('--late') ? Number(args[args.indexOf('--late') + 1]) * 1000 : 2000;
  await dappRound((uri) => setTimeout(() => svc.connect(uri), lateMs), lateMs + 90_000);
}

/** Genesis, top-up and withdraw for the owner key behind `pub` (receive/0), over mock UTXOs. */
function requestsFor(pub: Uint8Array): { name: string; payload: WizardSignPayload }[] {
  const pkh = hash160(pub);
  const enc = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh });
  const ownerAddress = typeof enc === 'string' ? enc : enc.address;
  const ownerLock = p2pkhLock(pkh);
  const rndPkh = () => hash160(secp256k1.derivePublicKeyCompressed(generatePrivateKey()) as Uint8Array);
  const payee = p2pkhLock(rndPkh());
  const provider = new MockNetworkProvider();
  const category = Buffer.from(generatePrivateKey()).toString('hex');
  const leash = new AgentLeash({ stateCategory: category, agentPkh: rndPkh(), ownerLock, allow: [payee], limit: 6000n, period: 3n, maxFee: 2000n }, provider);
  const addState = (sats: bigint, st = { elapsed: 0n, spent: 0n }) => provider.addUtxo(leash.tokenAddress, { ...randomUtxo({ satoshis: sats }),
    token: { category, amount: 0n, nft: { capability: 'mutable' as const, commitment: encodeState(st) } } }) as SpendableUtxo;
  const addOwner = (sats: bigint) => provider.addUtxo(ownerAddress, randomUtxo({ satoshis: sats })) as SpendableUtxo;
  const unl = () => placeholderP2PKHUnlocker(ownerAddress);
  const { builder: genesis } = buildGenesis({ provider, ownerUtxo: { ...addOwner(100_000n), vout: 0 }, ownerUnlocker: unl(), ownerAddress,
    params: { agentPkh: rndPkh(), ownerLock, allow: [payee], limit: 6_000n, period: 3n, maxFee: 2_000n }, fund: 40_000n });
  const topUp = leash.buildTopUp({ stateUtxo: addState(10_000n), ownerUtxo: addOwner(50_000n), ownerUnlocker: unl(), ownerAddress, amount: 20_000n });
  const withdraw = leash.buildWithdraw({ contractUtxos: [addState(40_000n, { elapsed: 1n, spent: 2205n })], ownerUtxo: addOwner(5_000n), ownerUnlocker: unl(), ownerAddress });
  return [
    { name: 'genesis', payload: toWizardSignRequest(genesis, { inputPaths: [[0, 'receive', 0]], userPrompt: 'AgentLeash TEST (chipnet, mock coins): create leash' }) },
    { name: 'top-up', payload: toWizardSignRequest(topUp, { inputPaths: [[1, 'receive', 0]], userPrompt: 'AgentLeash TEST (chipnet, mock coins): top up' }) },
    { name: 'withdraw', payload: toWizardSignRequest(withdraw, { inputPaths: [[0, 'receive', 0]], userPrompt: 'AgentLeash TEST (chipnet, mock coins): withdraw' }) },
  ];
}

/** Dapp side over the public relays: hand the URI to a wallet, then send the three sign requests. */
async function dappRound(onUri: (uri: string) => void, timeoutMs: number, logFile?: string): Promise<void> {
  const dapp = new DappConnectionManager('AgentLeash (chipnet test)', undefined, { session: false });
  const relay = initiateDappRelay((p) => dapp.updateConnection(p.client, p.status));
  dapp.attachRelay(relay);
  const record = (o: object) => { if (logFile) appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n'); };
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { check('wallet connected', false, `timeout ${timeoutMs / 1000} s`); resolve(); }, timeoutMs);
    dapp.on('walletready', async (msg: any) => {
      try {
        console.log(`relay: wallet_ready from "${msg.wallet_name}", protocols ${msg.supported_protocols?.join(',')}`);
        record({ event: 'wallet_ready', wallet: msg.wallet_name, protocols: msg.supported_protocols });
        const pub = dapp.getPubkey(0, 0n);
        if (!pub) throw new Error('no pubkey for receive/0');
        for (const { name, payload } of requestsFor(pub)) {
          const origTxHex = (payload.transaction as any).transaction;
          // Per-request timeout (30s) so dapp does not hang indefinitely if wallet never answers
          let timer: ReturnType<typeof setTimeout> | undefined;
          const res = await Promise.race([
            dapp.signTransaction(payload),
            new Promise<{ error: string; signedTransaction?: undefined }>((r) => { timer = setTimeout(() => r({ error: 'wallet signing request timed out (30s)' }), 30_000); }),
          ]).finally(() => clearTimeout(timer));
          if (res.error) { check(`${name}: "${msg.wallet_name}" signs`, false, `wallet error: ${res.error}`); record({ event: name, error: res.error }); continue; }
          if (!res.signedTransaction) { check(`${name}: "${msg.wallet_name}" signs`, false, 'no signedTransaction in the answer'); continue; }
          const v = verifySigned(res.signedTransaction, (payload.transaction as any).sourceOutputs, origTxHex);
          check(`${name}: "${msg.wallet_name}" signs over the relay, VM verify`, v === true, v === true ? '' : String(v));
          record({ event: name, vm: v === true ? 'ok' : String(v), signedTransaction: res.signedTransaction });
        }
      } catch (e: any) { check('relay round', false, String(e?.message ?? e)); record({ event: 'error', error: String(e?.message ?? e) }); }
      clearTimeout(timer); resolve();
    });
    onUri(relay.uri);
  });
}

main().catch((e) => { console.error('FAIL:', e?.stack ?? e); process.exit(1); });
