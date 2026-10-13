// Live WizardConnect round trip over the public Nostr relays (wss://relay.riften.net, wss://relay.cauldron.quest):
//   dapp (DappConnectionManager)  <-- encrypted relay -->  headless test wallet (WalletConnectionManager)
// The wallet is a throwaway HD key generated in memory (chipnet/testnet xpubs). The dapp derives the owner
// address from the wallet's xpub, builds an AgentLeash withdraw with placeholderP2PKHUnlocker over
// MOCK UTXOs (nothing is broadcast, no coins involved), sends it through the relay, receives the signed
// transaction and verifies it in the BCH 2026 VM.
//
// What this proves: transport, handshake, xpub delivery, sign request/response with a CashTokens state
// NFT in sourceOutputs. What it does NOT prove: that Paytaca or Selene sign the same request — that needs a
// phone (see README, "WizardConnect status").
//
// Usage: npx tsx scripts/wc-relay-smoke.ts
import { deriveHdPrivateNodeFromSeed, deriveHdPath, deriveHdPrivateNodeChild, deriveHdPublicNode, encodeHdPublicKey,
  encodeCashAddress, generatePrivateKey, hash160, secp256k1, type HdPrivateNodeValid } from '@bitauth/libauth';
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { WalletConnectionManager, type WalletAdapter } from '@wizardconnect/wallet';
import { MockNetworkProvider, placeholderP2PKHUnlocker, randomUtxo, type SpendableUtxo } from 'cashscript';
import { AgentLeash, encodeState, p2pkhLock, signWizardRequest, toWizardSignRequest, verifySigned } from '../src/index.js';

const T0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const fail = (m: string) => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => fail('timeout 90 s'), 90_000);

// ---- headless wallet ----
const master = deriveHdPrivateNodeFromSeed(generatePrivateKey()) as HdPrivateNodeValid;
const chain = (child: number) => deriveHdPath(master, `m/44'/145'/0'/${child}`) as HdPrivateNodeValid;
const CHILD: Record<string, number> = { receive: 0, change: 1, defi: 7 };
const privFor = (pathName: string, i: number) => deriveHdPrivateNodeChild(chain(CHILD[pathName]), i).privateKey;
const relayKey = generatePrivateKey();
const adapter: WalletAdapter = {
  walletName: 'agentleash headless test wallet',
  walletIcon: '',
  getRelayPrivateKey: () => relayKey,
  getPublicKey: (path, index) => secp256k1.derivePublicKeyCompressed(deriveHdPrivateNodeChild(chain(Number(path)), Number(index)).privateKey) as Uint8Array,
  getXpub: (path) => {
    const r = encodeHdPublicKey({ node: deriveHdPublicNode(chain(Number(path))), network: 'testnet' });
    if (typeof r === 'string') throw new Error(r);
    return r.hdPublicKey;
  },
  signTransaction: async () => { throw new Error('handled via pendingSignRequest'); },
};
const wallet = new WalletConnectionManager(adapter);
wallet.on('pendingSignRequest', ({ connectionId, request }) => {
  log(`wallet: sign request seq=${request.sequence} inputPaths=${JSON.stringify(request.inputPaths)}`);
  try {
    const hex = signWizardRequest({ transaction: request.transaction, inputPaths: request.inputPaths }, privFor);
    wallet.sendSignResponse(connectionId, request.sequence, hex);
  } catch (e: any) {
    wallet.sendSignError(connectionId, request.sequence, String(e?.message ?? e));
  }
});

// ---- dapp ----
const dapp = new DappConnectionManager('AgentLeash smoke', undefined, { session: false });
const relay = initiateDappRelay((p) => dapp.updateConnection(p.client, p.status));
dapp.attachRelay(relay);
log(`dapp: relay uri ${relay.uri.slice(0, 24)}...`);

dapp.on('walletready', async (msg) => {
  log(`dapp: wallet_ready from "${msg.wallet_name}", protocols ${msg.supported_protocols.join(',')}`);
  const pub = dapp.getPubkey(0, 0n);
  if (!pub) return fail('no pubkey for receive/0');
  const pkh = hash160(pub);
  const enc = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh });
  const ownerAddress = typeof enc === 'string' ? enc : enc.address;
  log(`dapp: owner address from xpub ${ownerAddress}`);

  const provider = new MockNetworkProvider();
  const agentPkh = hash160(secp256k1.derivePublicKeyCompressed(generatePrivateKey()) as Uint8Array);
  const payee = p2pkhLock(hash160(secp256k1.derivePublicKeyCompressed(generatePrivateKey()) as Uint8Array));
  const category = Buffer.from(generatePrivateKey()).toString('hex');
  const leash = new AgentLeash({ stateCategory: category, agentPkh, ownerLock: p2pkhLock(pkh), allow: [payee], limit: 6000n, period: 3n, maxFee: 2000n }, provider);
  const state = provider.addUtxo(leash.tokenAddress, { ...randomUtxo({ satoshis: 40_000n }),
    token: { category, amount: 0n, nft: { capability: 'mutable', commitment: encodeState({ elapsed: 1n, spent: 2205n }) } } }) as SpendableUtxo;
  const ownerUtxo = provider.addUtxo(ownerAddress, randomUtxo({ satoshis: 5_000n })) as SpendableUtxo;
  const tb = leash.buildWithdraw({ contractUtxos: [state], ownerUtxo, ownerUnlocker: placeholderP2PKHUnlocker(ownerAddress), ownerAddress });
  const payload = toWizardSignRequest(tb, { inputPaths: [[0, 'receive', 0]], userPrompt: 'AgentLeash: withdraw everything' });

  log('dapp: sending sign_transaction_request');
  const res = await dapp.signTransaction(payload);
  if (res.error) return fail(`wallet error: ${res.error}`);
  const ok = verifySigned(res.signedTransaction, (payload.transaction as any).sourceOutputs);
  log(`dapp: signed tx ${res.signedTransaction.length / 2} bytes, VM verify: ${ok}`);
  if (ok !== true) return fail(String(ok));
  console.log('PASS: WizardConnect relay round trip (handshake + xpub + sign) with AgentLeash withdraw');
  process.exit(0);
});

wallet.on('connectionStatusChanged' as any, (id: string, st: any) => log(`wallet: connection ${id} ${st?.status}`));
setTimeout(() => { log('wallet: connecting to dapp URI'); wallet.connect(relay.uri); }, 2000);
