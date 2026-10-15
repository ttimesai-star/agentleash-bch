// CHIPNET ONLY: send test coins from the project's chipnet owner wallet (alice) to an address.
// Used to fund test wallets for the web demo's end-to-end checks.
//   npx tsx scripts/chipnet-send.ts <bchtest:address> <sats>
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { hexToBin } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';

const [to, satsArg] = process.argv.slice(2);
if (!to?.startsWith('bchtest:')) throw new Error('refusing: destination must be a bchtest: (chipnet) address');
const amount = BigInt(satsArg ?? '0');
if (amount < 546n || amount > 1_000_000n) throw new Error('amount must be 546..1 000 000 sats');
const alice = JSON.parse(readFileSync(`${homedir()}/.claude/secrets/bch_chipnet_wallets.json`, 'utf8')).wallets[0];
if (!String(alice.address).startsWith('bchtest:')) throw new Error('refusing: not a testnet wallet');
const provider = new ElectrumNetworkProvider('chipnet');
const utxos = (await provider.getUtxos(alice.address)).filter((u) => !u.token);
const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
const fee = 200n + 150n * BigInt(utxos.length);
if (total < amount + fee + 546n) throw new Error(`alice has ${total} sats`);
const tb = new TransactionBuilder({ provider }).addInputs(utxos, new SignatureTemplate(hexToBin(alice.privHex)).unlockP2PKH())
  .addOutput({ to, amount }).addOutput({ to: alice.address, amount: total - amount - fee });
console.log('txid', await provider.sendRawTransaction(tb.build()));
process.exit(0);
