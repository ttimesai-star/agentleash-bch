// One capped end-to-end run of AgentLeash on a real network: genesis -> agent pays the payee once (with a
// receipt) -> one attack the network must refuse -> owner withdraws everything. Same code for chipnet
// (rehearsal) and mainnet (the BLAZE "sends BCH mainnet transactions" requirement). Logic: net-run-lib.ts.
//
//   npx tsx scripts/net-run.ts <chipnet|mainnet> status
//   npx tsx scripts/net-run.ts <chipnet|mainnet> run      [--broadcast] [--confirm-mainnet=<sats>:<addr tail>]
//   npx tsx scripts/net-run.ts <chipnet|mainnet> withdraw [--broadcast] [--state=<path>]
//
// Without --broadcast nothing is sent and nothing is written: the script builds every owner transaction,
// checks the caps and prints what it would do.
// Mainnet broadcast: AGENTLEASH_MAINNET_OK=yes in the environment (set only after the owner of the funds
// approved the run) AND, for `run`, --confirm-mainnet=<loss ceiling in sats>:<last 6 chars of the owner
// address> (printed by `status`). The loss ceiling (fund + every fee) is checked before anything is sent.
// Keys: chipnet = the project's chipnet secrets (alice owner, server payee); mainnet =
// ~/.claude/secrets/bch_mainnet_agentleash.json
//   { "network": "mainnet", "owner": { "privHex", "pkhHex", "address" }, "payee": { "address" } }
// The owner address is derived from privHex and must equal the file; a key known from chipnet secrets or
// the public demo is refused. Use a DEDICATED owner key that signs nothing else (README, AL-08).
// The agent key is generated per run. The run state (agent key + all contract parameters + planned txids)
// is written atomically to local/net-run-<net>.json (gitignored) BEFORE the first broadcast; the previous
// closed state is appended to local/net-run-<net>-history.jsonl. Keys are never printed.
// If a run is interrupted, `withdraw --broadcast` rebuilds the leash from that file and sweeps it back to
// the owner (or closes the run when the genesis never reached the network).
// Exit codes: 0 ok; 1 funds may still be on the leash (run `withdraw`); 2 refused before sending;
// 3 run ended and funds are back with the owner, but a demo step failed.
// Every broadcast goes to scripts/<net>-run-log.jsonl (txid or verbatim node error).
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { ElectrumNetworkProvider } from 'cashscript';
import {
  CAPS, EXIT, executeRun, executeWithdraw, knownTestnetPrivs, loadKeys, loadState, mainnetConfirmation, mainnetGate, type Ctx, type Net,
} from './net-run-lib.js';

const argv = process.argv.slice(2);
const net = argv[0] as Net;
const cmd = argv[1] ?? 'status';
const BROADCAST = argv.includes('--broadcast');
const opt = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main(): Promise<number> {
  if (net !== 'chipnet' && net !== 'mainnet') throw new Error('usage: net-run.ts chipnet|mainnet status|run|withdraw [--broadcast]');
  if (!['status', 'run', 'withdraw'].includes(cmd)) throw new Error(`unknown command ${cmd}`);
  const repoDir = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  const secretsDir = `${homedir()}/.claude/secrets`;
  const caps = CAPS[net];
  const keys = loadKeys(net, secretsDir, net === 'mainnet' ? knownTestnetPrivs(secretsDir, repoDir) : new Set());
  mainnetGate({ net, cmd, broadcast: BROADCAST, env: process.env, confirm: opt('confirm-mainnet'), caps, ownerAddress: keys.owner.address });

  mkdirSync(`${repoDir}/local`, { recursive: true });
  const statePath = opt('state') ?? `${repoDir}/local/net-run-${net}.json`;
  const logPath = `${repoDir}/scripts/${net}-run-log.jsonl`;
  const provider = new ElectrumNetworkProvider(net);
  const ctx: Ctx = {
    net, provider, keys, caps, broadcast: BROADCAST, statePath, historyPath: `${repoDir}/local/net-run-${net}-history.jsonl`,
    log: (e) => {
      const line = JSON.stringify({ at: new Date().toISOString(), net, ...e }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      if (BROADCAST) appendFileSync(logPath, line + '\n');
      console.log(line);
    },
  };

  if (cmd === 'status') {
    const sum = async (a: string) => (await provider.getUtxos(a)).reduce((s, x) => s + x.satoshis, 0n);
    console.log(net, 'height', await provider.getBlockHeight());
    console.log('owner', keys.owner.address, await sum(keys.owner.address), 'sats');
    console.log('payee', keys.payeeAddress, await sum(keys.payeeAddress), 'sats');
    console.log('caps', caps);
    const st = loadState(statePath);
    if (st) console.log('last run', { leash: st.leash, closed: st.closed, phase: st.phase, closeReason: st.closeReason, genesis: st.genesisTxid ?? st.genesis, withdraw: st.withdrawTxid ?? st.withdraw });
    if (st && st.closed !== true) console.log('OPEN RUN: leash holds', await sum(st.leash), 'sats; run `withdraw --broadcast`');
    if (net === 'mainnet') console.log(`mainnet run confirmation (loss ceiling ${caps.maxLoss} sats): --confirm-mainnet=${mainnetConfirmation(caps, keys.owner.address)}`);
    return EXIT.ok;
  }
  if (cmd === 'withdraw') return executeWithdraw(ctx);
  const code = await executeRun(ctx);
  if (!BROADCAST) console.log('dry run: every owner transaction built and checked locally; nothing sent, nothing written');
  return code;
}

main().then(
  (code) => { if (code !== EXIT.ok) console.error(`exit ${code}${code === EXIT.fundsMayRemain ? ': funds may still be on the leash, run withdraw' : ''}`); process.exit(code); },
  (e) => { console.error(`refused: ${e?.message ?? e}`); process.exit(EXIT.refused); },
);
