// Headless WizardConnect test wallet (CHIPNET) for end-to-end checks of the web page's owner path.
// The HD seed lives in local/wc-test-wallet.json (gitignored), testnet xpubs only.
//   npx tsx scripts/wc-test-wallet.ts address          receive/0 address (fund it with scripts/chipnet-send.ts)
//   npx tsx scripts/wc-test-wallet.ts connect <wiz://…> [minutes]
//        connects to the dapp URI over the public relays and approves every sign request with the
//        reference signer (signs only inputs locked to its own keys), logging each request.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import {
  binToHex, deriveHdPath, deriveHdPrivateNodeChild, deriveHdPrivateNodeFromSeed, deriveHdPublicNode, encodeCashAddress,
  encodeHdPublicKey, generatePrivateKey, hash160, hexToBin, secp256k1, type HdPrivateNodeValid,
} from '@bitauth/libauth';
import { WalletConnectionManager, type WalletAdapter } from '@wizardconnect/wallet';
import { signWizardRequest } from '../src/index.js';

const FILE = new URL('../local/wc-test-wallet.json', import.meta.url);
if (!existsSync(FILE)) {
  mkdirSync(new URL('../local/', import.meta.url), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ seed: binToHex(generatePrivateKey()) }));
}
const { seed } = JSON.parse(readFileSync(FILE, 'utf8'));
const master = deriveHdPrivateNodeFromSeed(hexToBin(seed)) as HdPrivateNodeValid;
const chain = (child: number) => deriveHdPath(master, `m/44'/145'/0'/${child}`) as HdPrivateNodeValid;
const CHILD: Record<string, number> = { receive: 0, change: 1, defi: 7 };
const privFor = (pathName: string, i: number) => deriveHdPrivateNodeChild(chain(CHILD[pathName]), i).privateKey;
const addr = (priv: Uint8Array) => {
  const r = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(secp256k1.derivePublicKeyCompressed(priv) as Uint8Array) });
  return typeof r === 'string' ? r : r.address;
};

const cmd = process.argv[2] ?? 'address';
if (cmd === 'address') {
  console.log(addr(privFor('receive', 0)));
  process.exit(0);
}
const uri = process.env.WIZ_URI || process.argv[3]; // env: Windows cmd splits a URI at '&'
if (!uri?.startsWith('wiz://')) throw new Error('usage: connect <wiz://…>');
const minutes = Number(process.env.WIZ_MINUTES || process.argv[4] || '10');
const sessionRelayKey = generatePrivateKey();
const T0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s] ${m}`);
const adapter: WalletAdapter = {
  walletName: 'AgentLeash headless test wallet (chipnet)',
  walletIcon: '',
  // fresh relay key per session: a reused key made the relay client drop the new dapp's messages as already processed
  getRelayPrivateKey: () => sessionRelayKey,
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
  log(`sign request seq=${request.sequence} inputPaths=${JSON.stringify(request.inputPaths)} prompt=${JSON.stringify((request as any).transaction?.userPrompt ?? '')}`);
  try {
    const hex = signWizardRequest({ transaction: request.transaction, inputPaths: request.inputPaths }, privFor);
    wallet.sendSignResponse(connectionId, request.sequence, hex);
    log(`signed ${hex.length / 2} bytes`);
  } catch (e: any) {
    log(`refused: ${e?.message ?? e}`);
    wallet.sendSignError(connectionId, request.sequence, String(e?.message ?? e));
  }
});
log(`wallet receive/0 ${addr(privFor('receive', 0))}; connecting`);
wallet.connect(uri);
setTimeout(() => { log('time is up'); process.exit(0); }, minutes * 60_000);
