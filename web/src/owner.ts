// The owner signs genesis, top-up and withdraw. Two kinds:
//  - WizardConnect: the owner's own wallet (Cashonize web, Selene, Paytaca) over the encrypted relay.
//    The page builds the transaction with a placeholder for the owner's input, the wallet signs only
//    that input, the page checks the answer (same inputs/outputs + full BCH 2026 VM) before broadcasting.
//  - Browser key: chipnet only, for judges without a chipnet-capable wallet. Never offered on mainnet.
import { binToHex, decodeHdPublicKey, generatePrivateKey, hash160, hexToBin, secp256k1 } from '@bitauth/libauth';
import { initiateDappRelay, type DappRelayResult } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { SignatureTemplate, placeholderP2PKHUnlocker, type SpendableUtxo, type TransactionBuilder, type Unlocker } from 'cashscript';
import { p2pkhLock, toWizardSignRequest, verifySigned, type InputPath } from '../../src/browser.js';
import type { NetConfig } from './config.js';
import { p2pkhAddress, providerFor } from './chain.js';

export interface OwnerCoin { utxo: SpendableUtxo; path: [pathName: 'receive' | 'change', index: number] }

export interface Owner {
  kind: 'wizard' | 'browser';
  label: string;
  /** Owner address = receive/0 for WizardConnect. Its P2PKH is the leash's ownerLock. */
  address: string;
  tokenAddress: string;
  lock: Uint8Array;
  coins(): Promise<OwnerCoin[]>;
  /** Unlocker to put on an owner input when building. */
  unlocker(coin: OwnerCoin): Unlocker;
  /** Sign the owner inputs (index -> coin) and return the final transaction hex, verified. */
  finalize(builder: TransactionBuilder, ownerInputs: { index: number; coin: OwnerCoin }[], prompt: string): Promise<string>;
  disconnect(): void;
}

const BROWSER_OWNER_KEY = 'agentleash.browserOwner.v1';

export function browserOwner(net: NetConfig): Owner {
  if (!net.burnerOwner) throw new Error('a browser-held owner key is only allowed on chipnet');
  let h = localStorage.getItem(BROWSER_OWNER_KEY);
  if (!h || !/^[0-9a-f]{64}$/.test(h)) { h = binToHex(generatePrivateKey()); localStorage.setItem(BROWSER_OWNER_KEY, h); }
  const priv = hexToBin(h);
  const pub = secp256k1.derivePublicKeyCompressed(priv) as Uint8Array;
  const pkh = hash160(pub);
  const address = p2pkhAddress(pkh, net);
  const sig = new SignatureTemplate(priv);
  const provider = providerFor(net);
  return {
    kind: 'browser',
    label: 'Browser key (chipnet only)',
    address,
    tokenAddress: p2pkhAddress(pkh, net, true),
    lock: p2pkhLock(pkh),
    async coins() {
      return (await provider.getUtxos(address)).filter((u) => !u.token).map((utxo) => ({ utxo, path: ['receive', 0] as ['receive', number] }));
    },
    unlocker: () => sig.unlockP2PKH(),
    async finalize(builder) { return builder.build(); },
    disconnect() {},
  };
}

const CHILD = { receive: 0, change: 1 } as const;

export interface WizardSession {
  uri: string;
  qrUri: string;
  ready: Promise<Owner>;
  cancel(): void;
}

/** Start a WizardConnect session; `ready` resolves when a wallet has connected and shared its xpubs. */
export function startWizard(net: NetConfig, onStatus: (s: string) => void): WizardSession {
  const dapp = new DappConnectionManager('AgentLeash', `${location.origin}${location.pathname.replace(/[^/]*$/, '')}icon.svg`, { session: false });
  const relay: DappRelayResult = initiateDappRelay((p) => { dapp.updateConnection(p.client, p.status); onStatus(String((p.status as any)?.status ?? p.status)); });
  dapp.attachRelay(relay);
  const provider = providerFor(net);
  const ready = new Promise<Owner>((resolve, reject) => {
    dapp.on('disconnect', (_r, m) => reject(new Error(`wallet disconnected${m ? ': ' + m : ''}`)));
    dapp.on('walletready', (msg) => {
      try {
        // the protocol has no network field: the xpub version tells which network the wallet is on
        const paths = dapp.getSessionPaths();
        const recv = paths.find((p) => p.name === 'receive');
        if (!recv) throw new Error('wallet shared no receive path');
        const dec = decodeHdPublicKey(recv.xpub);
        if (typeof dec === 'string') throw new Error(dec);
        const wantTestnet = net.name !== 'mainnet';
        if ((dec.network === 'testnet') !== wantTestnet) {
          throw new Error(`the wallet is on ${dec.network === 'testnet' ? 'a test network' : 'mainnet'}, this page is on ${net.name}. Switch the wallet (e.g. Paytaca: Settings > Use Chipnet Network) or switch the page.`);
        }
        const pubAt = (pathName: 'receive' | 'change', i: number) => {
          const pub = dapp.getPubkey(CHILD[pathName], BigInt(i));
          if (!pub) throw new Error(`wallet has no ${pathName}/${i} key`);
          return pub;
        };
        const pkh = hash160(pubAt('receive', 0));
        const address = p2pkhAddress(pkh, net);
        const scan: [('receive' | 'change'), number][] = [];
        for (let i = 0; i < 10; i++) scan.push(['receive', i]);
        for (let i = 0; i < 5; i++) if (dapp.hasPath(CHILD.change)) scan.push(['change', i]);
        const owner: Owner = {
          kind: 'wizard',
          label: msg.wallet_name || 'WizardConnect wallet',
          address,
          tokenAddress: p2pkhAddress(pkh, net, true),
          lock: p2pkhLock(pkh),
          async coins() {
            const out: OwnerCoin[] = [];
            for (const [name, i] of scan) {
              const a = p2pkhAddress(hash160(pubAt(name, i)), net);
              for (const utxo of await provider.getUtxos(a)) if (!utxo.token) out.push({ utxo, path: [name, i] });
            }
            return out;
          },
          unlocker: (coin) => placeholderP2PKHUnlocker(p2pkhAddress(hash160(pubAt(coin.path[0], coin.path[1])), net)),
          async finalize(builder, ownerInputs, prompt) {
            const inputPaths: InputPath[] = ownerInputs.map(({ index, coin }) => [index, coin.path[0], coin.path[1]]);
            const req = toWizardSignRequest(builder, { inputPaths, userPrompt: prompt });
            onStatus('waiting for the wallet to approve…');
            const res = await dapp.signTransaction(req);
            if (res.error || !res.signedTransaction) throw new Error(`wallet refused: ${res.error ?? 'no signed transaction'}`);
            const expected = (req.transaction as any).transaction as string;
            const ok = verifySigned(res.signedTransaction, (req.transaction as any).sourceOutputs, expected);
            if (ok !== true) throw new Error(`the wallet's answer failed verification, not broadcast: ${ok}`);
            return res.signedTransaction;
          },
          disconnect() { void dapp.sendDisconnect('user disconnect').finally(() => { relay.cleanup(); dapp.destroy(); }); },
        };
        resolve(owner);
      } catch (e) { reject(e); }
    });
  });
  return {
    uri: relay.uri,
    qrUri: relay.qrUri,
    ready,
    cancel() { try { relay.cleanup(); dapp.destroy(); } catch { /* already closed */ } },
  };
}

