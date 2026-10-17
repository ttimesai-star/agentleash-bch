# AgentLeash (BCH)

A spending leash for AI agents on Bitcoin Cash. The agent signs its own payments, but the
**network** (not a server, not the agent's code) enforces how much it can spend, to whom, and how
fast. The owner can take everything back at any time without the agent's key.

Built for BCH BLAZE 2026. License: MIT.

**Live demo (chipnet): https://ttimesai-star.github.io/agentleash-bch/**: open it, you are the agent of a
public demo leash whose agent key is published on purpose. Buy a tool over 402, then try to steal the money.

Presentation (BCH BLAZE "Widget Factory" template): [`docs/AgentLeash_BLAZE2026.pdf`](docs/AgentLeash_BLAZE2026.pdf).

## For judges: check it in 5 minutes

| Min | Do this | You should see |
|---|---|---|
| 1 | Open the [live demo](https://ttimesai-star.github.io/agentleash-bch/), click **Run the agent (3 tools)** | the agent plans each step, gets `402 Payment Required`, pays from the leash, the tool answers; a chipnet txid per call; the gauge moves |
| 2 | Click **Run until the leash says no** (or keep buying by hand) | the agent's own SDK refuses **before signing**: `limit exceeded: N of 12000 sats spent ... M left` |
| 3 | "Try to break it": press each of the 5 buttons | each signs a real rule-breaking transaction with the published agent key; the node refuses it, shown **verbatim** (`mandatory-script-verify-flag-failed`, `non-BIP68-final`) plus the contract rule that failed |
| 4 | Journal; click any txid | every payment on [chaingraph](https://chipnet.chaingraph.cash) with its `OP_RETURN "LSH1"` receipt |
| 5 | Optional, in a terminal: `git clone https://github.com/ttimesai-star/agentleash-bch && cd agentleash-bch && npm ci && npm test && npm run agent` | 214 tests pass; the agent runs offline on a mock network that executes the real covenant, then a compromised phase whose rule-breaking transactions are refused. `npm run agent:chipnet` does the same with real chipnet transactions on the public demo leash (no keys needed) |

The public demo leash is shared: if other visitors used up its window (12 000 sats per 6 blocks), the agent is
refused right away. That is the leash working; the window reopens after the blocks shown on the page. You can also
create your own leash with free chipnet coins ("Create your own").

### What works today (chipnet, with txids in this README) and what is planned

| | State |
|---|---|
| Covenant: budget per window incl. fees, 3 payees, fee cap, proven-age clock, owner exit | **works on chipnet**, 187 tests incl. 29 attacks |
| 402 paywall (`leash` scheme) + agent client, incl. 1-confirmation settlement | **works on chipnet** |
| Demo agent (scripted planner, or any OpenAI-compatible LLM with your key) | **works on chipnet** (16.10.2026, see "Demo agent") |
| Web demo: autopilot, tools, 5 attacks, journal, create / top up / withdraw | **live on chipnet**, Electrum failover between two public servers |
| WizardConnect owner path | **works** with a headless wallet over the public relays and with Paytaca's own signing code; **not yet tested** in the Paytaca, Cashonize and Selene apps |
| Mainnet | **planned, not done**: one capped run (owner funds at most ~3 USD: genesis, an agent payment, an attack the network refuses, withdraw) with `scripts/net-run.ts`; the script is rehearsed on chipnet. Mainnet txids will be added here after the run; until then nothing in this README claims mainnet |

## Status (honest): prototype, unaudited

**Prototype, unaudited. Chipnet only for now. Do not put real money in it.** No external users yet; no
professional audit; the contract is not frozen. A capped mainnet run is prepared (see "Mainnet run"), not done.

| Part | State (16.10.2026) |
|---|---|
| `contracts/AgentLeash.cash` (CashScript 0.14) | v0. Two automated review passes (Jules, `REVIEW.md`), not a professional audit. Not frozen. |
| TypeScript SDK (`src/`) | genesis, pay, top-up, withdraw, receipt + request-hash helpers |
| WizardConnect owner path (`src/wc.ts`) | sign-request builder, relay serialization, reference signer for tests, VM verification. Live relay round trip PASS. Paytaca's own signing code (pinned commit) signs genesis, top-up and withdraw, offline and over the relay through Paytaca's own connection manager: PASS. **The Paytaca app on a phone is not yet tested** (UI only, see below). |
| 402 paywall, `leash` scheme (`src/x402.ts`, `src/x402-client.ts`, `src/http.ts`) | works on mock and on chipnet (real transactions, see below). `exact` scheme not implemented and not advertised. |
| Tests (vitest, MockNetworkProvider with validation) | **217** (17.10.2026): 187 below + 29 capped-run script (`test/net-run.test.ts`, security review 16.10: state on disk before the first broadcast, lost genesis response, crash after genesis then `withdraw` from the file, rejected withdraw, loss ceiling, mainnet barrier, chipnet key in the mainnet file; Jules stage 4: lost withdraw response, lagging server, vanished genesis, payee network, key redaction in logs; stage 5: case-insensitive literal redaction, key redacted in the closed-run line, server errors never close a run) + 1 `validateParams` hardening. The 187: 159 below + 17 demo agent (`test/agent.test.ts`: pays until the window refuses, compromised phase refused, maxPrice / allow-list / node refusal classified, LLM planner over a fake OpenAI-compatible API, real HTTP) + 10 Electrum failover + 1 fake-reset guard (incl. Jules round 6, REVIEW.md stage 3). The 159: 94 stage-1 (happy paths, 29 attacks, owner path, property test, 39 from two review passes) + 9 WizardConnect (incl. Jules round 5: tuple/path/index validation, `verifySigned(tx, src, expectedTxHex)` refuses a wallet that changed inputs or outputs) + 7 "try to break it" builders (`src/attacks.ts`) + 49 paywall/agent (incl. Jules review fixes: dust floor, nonce cap, header case, minConfirmations; round 2: "already known" broadcast checked against the node, handler failure after payment, 429 when every nonce is in flight, poll retry; round 3: retry during an in-flight broadcast gets 202, abort ends the confirmation wait at once; round 4: Electrum confirmation errors count as 0, Headers/tuple request headers kept) |
| Chipnet | stage-1 scenario (covenant) and stage-2 scenario (402 server + agent), logs in `scripts/` |
| Web UI (`web/`, static, GitHub Pages) | **live on chipnet** (16.10.2026): network flag (chipnet default, mainnet locked by a build flag), public demo leash, 3 paid tools over the 402 `leash` scheme, "try to break it" (5 attacks broadcast to the node, verbatim refusal shown), journal from the chain, create / top up / withdraw by the owner via WizardConnect or a chipnet-only browser key. End-to-end in headless Chromium, see "Web demo" |
| Demo agent (`src/agent.ts`, `scripts/agent.ts`) | **works on chipnet** (16.10.2026): planner (scripted, or any OpenAI-compatible LLM) chooses tools, pays each over 402 from the leash, refused before signing past the window; compromised phase broadcasts rule-breaking transactions, the node refuses. Web page: same loop as an autopilot button |
| Mainnet | **not done**; capped run script prepared and rehearsed on chipnet (`scripts/net-run.ts`) |

## How it works

Funds sit in a P2SH32 covenant. Its state is a single **mutable NFT** whose commitment is
`elapsed (8 bytes LE) | spent (8 bytes LE)`.

`pay(agentPk, agentSig, elapsedAdd)` — the only way the agent can move money. The transaction shape is fixed:

| | |
|---|---|
| `in[0]` | the contract UTXO carrying the state NFT (exactly one input) |
| `out[0]` | back to the contract: state NFT with the new commitment + change (>= 1000 sats) |
| `out[1]` | payment to one of 3 allow-listed locking bytecodes, no tokens, >= 546 sats |
| `out[2]` | receipt `OP_RETURN "LSH1" <32-byte request hash>`, 0 sats |

Checked by the contract: agent key and signature; category **and** capability of the NFT
(exactly `mutable`, no fungible amount); fee `<= maxFee`; and the window:

```
outflow = in[0].value - out[0].value                 // payment + miner fee
require(outflow - amount <= maxFee)
require(elapsedAdd >= 0 && elapsedAdd < 65536 && this.age >= elapsedAdd)   // CSV / BIP68
e' = elapsed + elapsedAdd ; s' = spent + outflow
if e' >= period: (e', s') = (0, outflow)             // window rolls over
require(s' <= limit) ; out[0].commitment == e' | s'
```

The limit counts **everything that leaves the contract**, fees included. A first draft counted only
the payment; then an agent could make many 546-sat payments with `maxFee` each and burn several times
the limit in fees per window. Test `fee burn: fees count against the limit` covers it.

The clock only advances by `elapsedAdd`, which the network proves through the input's relative
locktime (the UTXO really is that many blocks old). So the agent can never make time run faster than
the chain. An alternative design that stores `periodStart = tx.locktime` lets the agent backdate
locktime and claim k windows at once after k idle periods; this design avoids it.

`owner(ownerInputIndex)` — valid whenever the transaction also spends an input whose locking
bytecode is the owner's P2PKH. The owner's wallet signs that input (SIGHASH_ALL), so the owner
can withdraw, top up, reset, migrate to new rules, or absorb stray UTXOs. No agent key needed.

Rules (`limit`, `period`, `maxFee`, allow-list) are constructor parameters, i.e. part of the address.
Changing them = owner migrates the NFT and funds to a new address.

### Known properties and limits

- **Fixed window**: worst case is `limit` at the end of a window plus `limit` right after the reset,
  i.e. `2 x limit` within a short span. The property test asserts exactly this bound.
- Unused allowance is not carried over; the new window starts at the first payment after expiry
  (the clock is conservative: it never runs ahead of real time).
- The owner path trusts the owner's wallet: the owner input must be signed with `SIGHASH_ALL`
  (the default in CashScript and in common BCH wallets). A `NONE`/`SINGLE`/`ANYONECANPAY` signature
  on that input would let others rewrite the withdrawal outputs (review AL-08).
- **Use a dedicated owner address** that holds nothing else and signs nothing else (review AL-08, security review
  16.10). The owner path only checks that *some* input is locked by `ownerLock`; if the same key ever signs a
  partial transaction (`ANYONECANPAY`, e.g. a marketplace offer or a coinjoin), that input can be glued to the
  leash input and the whole leash drained by whoever holds the partial transaction.
- The SDK refuses unsafe parameters before genesis (`validateParams`): `ownerLock` must be a standard P2PKH script,
  allow-list entries must be P2PKH / P2SH20 / P2SH32 (no `OP_1` anyone-can-spend, no `OP_RETURN` burn), and the
  agent key must differ from the owner key. The contract itself does not check these; a hand-made deployment can
  skip them.
- The allow-list is the owner's trust decision: if an allow-listed script forwards funds to the agent,
  the contract cannot see it (review AL-09). Use plain P2PKH payees you control or trust.
- One state UTXO = payments are strictly sequential (unconfirmed chains are fine, `elapsedAdd = 0`).
- `elapsedAdd` must be < 65536: CSV ignores bits above 16 and treats bit 22 as "time units", so
  without that bound an agent could claim 65536 or `2^22 + 1` "blocks" with a zero-age UTXO. Tests cover both.
- `stateCategory` is passed to the contract in VM byte order (reverse of the displayed category hex);
  the SDK does this (`categoryToVmBytes`), and a test shows that the wrong order makes the leash unusable.
- Off-chain: the receipt hash binds a payment to an HTTP request
  (`sha256(nonce | method | url | sha256(body))`, length-prefixed). Replay protection of the nonce is the
  402 server's job (one-time nonce in `src/x402.ts`).

## Attack matrix (each is a test in `test/leash.test.ts`)

| Attack | Result |
|---|---|
| pay a non-allow-listed address / the agent itself | `pay: recipient not allow-listed` |
| exceed the limit (single or cumulative) | `pay: limit exceeded` |
| burn the balance through fees on many tiny payments | `pay: limit exceeded` (fees count) |
| write a fake "reset" state early | `pay: limit exceeded` |
| under-report `spent` | `pay: wrong new state` |
| drain through the miner fee | `pay: fee above maxFee` |
| send change/NFT elsewhere, or drop the NFT | `pay: change must return to contract` / `pay: state NFT must return` |
| own mutable NFT of another category on the contract address | `pay: input lacks state NFT` |
| right category with capability `none` / `minting` | `pay: input lacks state NFT` |
| fungible tokens on the state input | `pay: input carries fungible tokens` |
| 4th output, missing receipt | `pay: exactly three outputs` |
| 2 inputs (state + stray), stray bare UTXO alone | `pay: exactly one input` / `pay: input lacks state NFT` |
| malformed receipt (length, prefix, used as a payment) | `pay: bad receipt length` / `pay: bad receipt prefix` |
| claim more age than proven | `pay: elapsedAdd exceeds proven UTXO age` |
| CSV masking (`65536`, bit 22) | `pay: elapsedAdd out of range` |
| negative `elapsedAdd` | `pay: negative elapsedAdd` |
| someone else signs (griefing) / agent pubkey + foreign signature | `not the agent key` / signature failure |
| agent tries `owner()` with its own input, or points at the contract input | `owner: no owner input` |

## Chipnet run (real transactions, 10.10.2026)

Rules: `limit` 6000 sats, `period` 3 blocks, `maxFee` 2000 sats. Owner, agent and payee are
separate chipnet keys. Log of every broadcast, including verbatim node errors:
[`scripts/chipnet-log.jsonl`](scripts/chipnet-log.jsonl).

Leash address `bchtest:rwkq7xj93eh0ewxhq77ldel2a03cr5qhwpnj5uxz7ugrch8xnpwg6qp5qsqjm`,
state NFT category `77bb874f49fa2fafd16b09a6385b7ef8573f9e1bb7c54fd301f3be1c358c4f69`.

| Step | Result | txid / node response |
|---|---|---|
| genesis (owner): 1 mutable NFT, state (0,0), 40 000 sats | accepted | `fcc6a0dc29fb80167cbeb51e8398ffe22028f4ec162b3ce8c90ce03cb1493a90` |
| agent pays 1500 (+705 fee) | accepted, state (0, 2205) | `d7c63eb0c49bf21e1f51ffdbdd94a6a21b744ba27ce103399f7bc899060a98f4` |
| agent pays 1000 (+705 fee) | accepted, state (0, 3910) | `b1b94befe0ad74a36f5cda5a033f5ebc14a022ad30a234e6a5a703ccfd141265` |
| attack: pay the agent's own address | **rejected by node** | `mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)`; local: `pay: recipient not allow-listed` |
| attack: fee 2001 > maxFee | **rejected by node** | same; local: `pay: fee above maxFee` |
| attack: claim 3 blocks of age on a 0-conf UTXO | **rejected by node** | `non-BIP68-final (code 64)` |
| attack: write a reset state without proven age | **rejected by node** | `... finished with a false/empty top stack element`; local: `pay: wrong new state` |
| attack: 1 sat over the limit | **rejected by node** | `... OP_VERIFY ...`; local: `pay: limit exceeded` |
| agent asks SDK for 2500 more | refused before signing | `limit exceeded: 3910 of 6000 sats spent in this window, 3205 requested (payment + fee), 2090 left` |
| 3 blocks later: agent pays 3000 with `elapsedAdd = 3` | accepted, window reset, state (0, 3705) | `a21e3018093ca5d1818911019c2b6f417d4a3c799479829b163d407c12c37f5e` |
| owner withdraws everything (one owner input, NFT burned) | accepted | `e81d18abfa92a636c3e455608c06b2dd8f9b8751e841e8d472dbcc82e8c4d253` |

An earlier draft of the contract (fees not counted in the limit, see above) was also run on chipnet:
genesis `14d06b91374a76aee15d725a21e1a7d2ff63da233c3e936062aa2574cd06f363`, owner withdraw
`77bb874f49fa2fafd16b09a6385b7ef8573f9e1bb7c54fd301f3be1c358c4f69`
([`scripts/chipnet-log.v0a.jsonl`](scripts/chipnet-log.v0a.jsonl)).

A pay transaction is 700 bytes (fee 705 sats at 1 sat/byte); owner withdraw of one UTXO 598 bytes.

Note: on a chain node the contract-level rejections all surface as
`mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation)`; the clock attack is
rejected one layer earlier by consensus (`non-BIP68-final`). The `localReason` field in the log is the
failing `require` from CashScript's local debugger for the same transaction hex.

## 402 paywall (`leash` scheme)

Message shape follows x402 v2: `402` + `PAYMENT-REQUIRED` (base64 JSON), retry with `PAYMENT-SIGNATURE`,
`200` + `PAYMENT-RESPONSE` with the txid. Network ids `bch:bchtest` / `bch:bitcoincash`, amount in sats as a string.
The `leash` scheme is ours (x402 `exact` for BCH allows only P2PKH inputs, so a covenant payment cannot use it):

- the challenge carries a one-time `nonce` (16 bytes, TTL 120 s, bound to method + path);
- the payload is the fully signed AgentLeash `pay` transaction; the server checks: 3 outputs, `out[1]` pays `payTo`
  at least the price with no tokens, `out[2]` is `LSH1` with `requestHash = sha256(nonce | method | url | sha256(body))`;
- the nonce is consumed, the transaction is broadcast (mempool settlement), the content is returned;
  a rejected broadcast reopens the nonce;
- optional `minConfirmations` (with a `confirmations(txid)` source, e.g. `electrumConfirmations(provider)`):
  broadcast, answer `202` + `PAYMENT-RESPONSE` (no new challenge), serve when the same payment is re-sent after
  N confirmations; `leashFetch({ awaitConfirmations })` re-sends it and never pays twice. Run on chipnet with a real block, see below;
- route prices below dust (546 sats) are refused at start; the nonce store is capped (`maxNonces`, default 10 000).

The agent client (`leashFetch`) refuses prices above its `maxPrice`, payees outside the leash allow-list, and
anything over the covenant window (`LimitExceededError`) **before signing**.

Chipnet run, 13.10.2026 (`npx tsx scripts/x402-chipnet.ts run`, log `scripts/x402-chipnet-log.jsonl`),
rules: limit 6000 sats / 3 blocks, maxFee 2000, price 1500 sats:

| Step | Result | txid / response |
|---|---|---|
| genesis (owner), 20 000 sats | accepted | `f1724b91583953010cb75c43b7b91b95cd42dda82cb2b6a4e54468cd1a253be3` |
| GET /price without payment | 402 + challenge | nonce `fee8473a...` |
| retry with payment | 200, settled | `9549bc3cdf7466c091bed82a430c2659a51da529c2d991ae695cbd1272389394` |
| replay the same payment header | 402 | `nonce already used` |
| second call (`leashFetch`, chained on the unconfirmed state) | 200, state (0, 4410) | `21833be355ce1cec56fa58dbbd5059678965120114873eb6e8bbf9c8fc21838b` |
| third call | refused by the SDK before signing | `limit exceeded: 4410 of 6000 sats spent in this window, 2205 requested (payment + fee), 1590 left` |

Chipnet run with `minConfirmations: 1`, 14.10.2026 (`npx tsx scripts/x402-chipnet.ts run-conf`, same log
`scripts/x402-chipnet-log.jsonl`, lines with `"step":"conf: ..."`). Server: `LeashPaywall` with
`confirmations: electrumConfirmations(provider)` (verbose `blockchain.transaction.get` on the chipnet Fulcrum).
Agent: `leashFetch` with `awaitConfirmations { intervalMs: 30 000, timeoutMs: 40 min }`.

| Step | Result | txid / response |
|---|---|---|
| before | leash 15 590 sats, state (0, 4410), payee 13 000 sats, tip 327781 | state `21833be3...` |
| GET /price without payment | 402 + challenge | nonce `37a6e1a6...` |
| retry with payment, 02:09:54 UTC | 202 `awaiting 1 confirmation(s), have 0`, broadcast | `dcdc46634f8cd500cca59a3fe69d35908eab1d39a1442161aa389a8393f0b0ea` |
| 14 re-sends of the same `PAYMENT-SIGNATURE`, every ~33 s | 202, server check `confirmations: 0` each time | same txid |
| 15th re-send, 02:18:07 UTC, after block 327782 | 200, content, `PAYMENT-RESPONSE success: true` | mined at height 327782 |
| balances after | handler ran 1 time; payee +1500 (one UTXO from that txid); leash -2206 = 1500 + fee 706, covenant `spent` = 2206 | |
| re-send the served payment | 402 | `nonce already used`; leash state and payee balance unchanged |

Wait from 202 to 200: 495 s (one chipnet block). What this run proves: the two-phase path works against a real
node and a real block, the client re-sends one and the same payment (16 paid requests, one signature hash), the
content is served once and the money moves once. Not covered here: a double spend while waiting (the payment
is never confirmed, the nonce is dropped after `confirmTimeoutMs`), a reorg, `minConfirmations` > 1, a server
restart during the wait (nonces live in memory, so a restarted server would not serve an already paid request).

Known limits of the server: nonces live in memory (one process; a restart forgets open challenges);
settlement is 0-conf by default (a payer could try a double spend before confirmation; double-spend proofs are not
checked; `minConfirmations` trades that for a wait of about 10 minutes per block); the package entry imports `node:http`; browsers use `src/browser.ts` (same SDK without the HTTP adapter; the paywall itself no longer needs `Buffer` or `node:crypto`).

Before running the paywall with real money (security review 16.10):
- **HTTPS outside localhost.** `PAYMENT-SIGNATURE` is a bearer token: whoever sees the header before the server
  does can submit the same signed payment for their own request on the same nonce. Plain HTTP only on localhost.
- **`minConfirmations` defaults to 0.** At 0 the payer (the agent, or the owner through the owner path) can
  double-spend the leash coin after the content is served and leave the server unpaid. Set `minConfirmations: 1`
  or more when the content is worth more than the payment you are willing to lose.
- `electrumConfirmations(provider)` trusts one Electrum server for the confirmation count; for real money ask two
  independent servers, or your own node.

## Demo agent (`npm run agent`, `npm run agent:chipnet`)

An agent that actually lives on the leash: `src/agent.ts` (loop, planners, journal), `scripts/agent.ts` (one command).

- **Phase 1, the agent works.** A planner chooses the next step (call a tool or finish). The agent calls the tool over
  real HTTP: its own 402 tool server (`LeashPaywall` + `servePaywall`, 3 tools: chain tip, BCH price, fortune) runs on
  127.0.0.1; `leashFetch` answers each `402` with a covenant payment carrying an `LSH1` receipt bound to the request; the
  server broadcasts it and serves. Every step goes to a journal (console; chipnet runs also to
  [`scripts/agent-chipnet-log.jsonl`](scripts/agent-chipnet-log.jsonl)). Refusals are labelled by who refused:
  `sdk` (before signing: over the window, price above `maxPrice`, payee not on the allow-list), `server`, `network` (the
  node rejected the broadcast), `agent` (the planner asked for a tool that does not exist).
- **Phase 2, the agent is compromised.** It ignores its SDK and signs raw transactions that break one rule each
  (`src/attacks.ts`) and broadcasts them. Any acceptance would be reported as `BREACH` and exit code 2.
- **Planner.** Default: a scripted planner (no model, deterministic; asks past the budget on purpose so the leash has to
  say no). With `AGENT_LLM_BASE_URL`, `AGENT_LLM_API_KEY`, `AGENT_LLM_MODEL` set, an LLM over any OpenAI-compatible
  chat API chooses instead. The model only picks a tool or finishes; it never sees a key and cannot choose a payee or an
  amount; tool answers are passed to it as untrusted data. Checked on 16.10.2026 with
  `openai/gpt-oss-20b` on NVIDIA NIM, on the mock network and on chipnet (below); free tiers of other providers
  answered 403/402/429 that day, which the planner reports as an error.
- **Networks.** `mock` (default): CashScript's MockNetworkProvider, which executes the covenant in the BCH VM for every
  broadcast; no coins, works offline. `--net chipnet`: the public demo leash of the web page (agent key published in
  `web/src/demo.json`), so no secret is needed. Mainnet is refused by this script.

Chipnet run, 16.10.2026 (`npm run agent:chipnet`, scripted planner, public demo leash
`bchtest:rw2x8a46d9xm0u8zqxyfej0n04znxglu6a4twu53rfkx5pgpasw3sva873j5u`, 12 000 sats per 6 blocks, fee cap 2 000):

| Step | Result | txid / response |
|---|---|---|
| 1 chain_tip, 402, pays 1 000 | 200, block 328162 | `51fbf483111a2360ea31ac59cce8cc7bd82182c1f04caa05b7747640054a37e7` |
| 2 bch_price, pays 1 500 | 200, BCH 273.92 USD (CoinGecko) | `504ade2ce2d7bfde695b4d23aeeadbb422fd2d3cf2c15cda0703094b6f73ac2c` |
| 3 fortune, pays 600 | 200 | `edcc9ea0edfb571f67f7d4eac1f8a19b9ac5368a6291c47616d6432b67b5dcd3` |
| 4-6 chain_tip (keep watching) | 200 each | `d87f4d1c…40307`, `4f974abd…35237`, `8327d31f…f39c36` |
| 7 chain_tip | refused before signing | `limit exceeded: 10331 of 12000 sats spent in this window, 1705 requested (payment + fee), 1669 left` |
| compromised: pay a non-allow-listed address | rejected by the node | `mandatory-script-verify-flag-failed (Script failed an OP_VERIFY operation) (code 16)`; rule `pay: recipient not allow-listed` |
| compromised: 1 sat over the limit | rejected by the node | same; rule `pay: limit exceeded` |
| compromised: fast-forward the clock | rejected by consensus | `non-BIP68-final (code 64)` |

Chipnet run with the **LLM planner**, 16.10.2026 22:39 Minsk (`openai/gpt-oss-20b` on NVIDIA NIM, same leash, the window
already had 5 215 sats spent by the web autopilot run): the model chose chain_tip, bch_price, fortune (paid:
`3a70902aefa458be69dbf6eaaefa5d059ce8980b248dcbc3ed51fd90335d5ac4`, `bb41008a3f04f8bb4cf18e7fba214cb23e516c854d73206258854c5941159a32`,
`f3400225a171288c3039c2d5797e211db062782f9f7d37613d7bfcfc7071450c`), then chain_tip again to keep watching, which the SDK
refused before signing (`limit exceeded: 10430 of 12000 sats spent in this window, 1705 requested (payment + fee), 1570 left`);
the model then finished with the brief (block 328170, 273.50 USD, a fortune). The compromised phase was refused by the node
as above. Journal: `scripts/agent-chipnet-log.jsonl` (the key is not logged).

Found while building it: on a fresh window (state 0, 0) the "fake reset" attack is the honest next state, so the
network rightly accepts it and the demo would have shown a false breach. `buildAttack('fakereset')` now refuses to
build it there (test in `test/attacks.test.ts`).

## WizardConnect status

WizardConnect is Riften Labs' dapp-to-HD-wallet protocol over an encrypted Nostr relay (`hdwalletv1`),
libraries `@wizardconnect/{core,dapp,react,wallet}` 0.2.x, LGPL-3.0
([docs](https://docs.riftenlabs.com/wizardconnect/), [repo](https://gitlab.com/riftenlabs/lib/wizardconnect)).
We only link the libraries, no modifications.

How AgentLeash uses it: only the **owner** signs through the wallet (genesis, top-up, withdraw). On the
owner path the contract input needs no signature (`owner(ownerInputIndex)`), so the wallet signs just its
own P2PKH input. The agent signs `pay` with its own key.

| Question | Answer | Source / evidence |
|---|---|---|
| Can a wallet sign our owner-path transactions? | Per spec yes: the wallet signs the inputs named in `inputPaths` with `SIGHASH_ALL, UTXOS, FORKID` (0x61); contract inputs with pre-set unlocking bytecode may be omitted | `docs/protocol.md`, `docs/wallet.md` in the repo |
| Does the state NFT survive the relay? | Yes, `sourceOutputToRelay` keeps category, amount, capability, commitment | `@wizardconnect/core` 0.2.4 `hdwalletv1-serialize.js`; test `withdraw: wallet signs only its input` |
| Network (chipnet) field in the protocol? | None. The wallet decides; the xpub version shows it | `@wizardconnect/core` types |
| Paytaca | Open-source WizardConnect code: chipnet mode (Settings -> "Use Chipnet Network": `bchtest` prefix, testnet xpub), signs P2PKH inputs from `inputPaths` with 0x61, leaves other inputs untouched, accepts token source outputs; Apps -> WizardConnect accepts a pasted `wiz://` URI | [paytaca-app `src/wallet/wizardconnect/service.js`](https://github.com/paytaca/paytaca-app/blob/master/src/wallet/wizardconnect/service.js), [`src/wallet/bch-sign.js`](https://github.com/paytaca/paytaca-app/blob/master/src/wallet/bch-sign.js) |
| Selene | Listed as a WizardConnect wallet; source not found, chipnet support **unknown** | [Riften wallet table](https://docs.riftenlabs.com/cauldron/wallets) |
| Relay transport with our transactions | **PASS** 13.10.2026: dapp and a headless test wallet over `wss://relay.riften.net` + `wss://relay.cauldron.quest`: handshake, xpub, sign request/response for a withdraw carrying the state NFT, VM-verified | `npx tsx scripts/wc-relay-smoke.ts` |
| Paytaca's signing code on our requests | **PASS** 15.10.2026: `service.js` `signRequest` + `bch-sign.js` from paytaca-app commit `bfeaefe9` (sha256 printed by the script; files downloaded, not vendored: the repo has no licence) sign genesis, top-up and withdraw in chipnet mode; all three pass the BCH 2026 VM. With `--relay`, Paytaca's own `getManager()` (its adapter, `@wizardconnect/wallet`) answers our dapp over the public relays, also when it joins 45 s late | `npx tsx scripts/paytaca-compat.ts --relay --late 45` |
| What Paytaca does NOT check | An `inputPath` that names the contract input is not refused: the relay drops the `contract` field, the input already has an unlocking bytecode, so Paytaca signs nothing and returns the transaction with the owner input unsigned. Duplicate indices are not refused either. The dapp must run `verifySigned` before broadcasting (our builder and reference signer refuse both cases) | `scripts/paytaca-compat.ts` negative check; `test/wc.test.ts` |
| The web page as the dapp, real relay, real chipnet | **PASS** 16.10.2026 with a headless HD wallet: create (incl. the prepare-coin step) and withdraw signed over the relay, checked with `verifySigned(signed, src, requestedTx)` and accepted by chipnet (see "Web demo") | `scripts/wc-test-wallet.ts` |
| The Paytaca app on a phone (UI: pairing, approval dialog, release build) | **NOT TESTED**. One manual run: `npx tsx scripts/paytaca-compat.ts --phone` prints a `wiz://` URI, the phone pastes it, approves 3 requests over mock coins (nothing is broadcast); answers are VM-verified and logged to `scripts/paytaca-phone-log.jsonl` | open item |

Security notes from the tests: with `SIGHASH_UTXOS`, a dapp that lies to the wallet about the state NFT gets a
signature the network rejects; the reference signer refuses an input path that is not the wallet's own P2PKH.
`signWizardRequest` in `src/wc.ts` is a test double, not a wallet.

## Usage

```bash
npm install
npm test            # vitest, MockNetworkProvider
npm run compile     # cashc -> artifacts/
npx tsx scripts/chipnet.ts status|genesis|pay <sats>|attack <kind>|withdraw
npx tsx scripts/x402-chipnet.ts status|run|withdraw   # 402 server + agent on chipnet
npx tsx scripts/wc-relay-smoke.ts                     # WizardConnect relay round trip
npx tsx scripts/paytaca-compat.ts [--relay [--late 45] | --phone]  # Paytaca's own signer on our requests
npx tsx scripts/demo-leash.ts status|create|topup <sats>             # public demo leash of the web page (chipnet)
npx tsx scripts/net-run.ts chipnet|mainnet status|run|withdraw [--broadcast]  # capped end-to-end run
npm run agent                                                        # demo agent, mock network (offline)
npm run agent:chipnet                                                # demo agent, real chipnet, public demo leash
npx tsx scripts/wc-test-wallet.ts address|connect                    # headless WizardConnect wallet (URI in WIZ_URI)
npm run web:dev                                                      # web demo locally; npm run web:build -> web/dist
```

```ts
import { AgentLeash, buildGenesis, computeRequestHash } from 'agentleash-bch';

const { leash, builder } = buildGenesis({ provider, ownerUtxo /* vout 0 */, ownerUnlocker, ownerAddress,
  params: { agentPkh, ownerLock, allow: [serverLock], limit: 20_000n, period: 144n, maxFee: 2_000n }, fund: 100_000n });
await builder.send();

const { state } = await leash.getUtxos();
const tx = leash.buildPay({ stateUtxo: state!, agentPrivateKey, payTo: serverAddress, amount: 1_000n,
  requestHash: computeRequestHash({ challengeNonce, method: 'GET', url }), elapsedAdd /* <= real age */ });
await tx.send();
```

`buildPay` mirrors the contract off-chain and throws `LimitExceededError` with "N left, resets in ~M blocks"
before anything is signed, so an agent gets a readable reason instead of a node error.

## Web demo

**https://ttimesai-star.github.io/agentleash-bch/** (static site, `web/`, built and published by
`.github/workflows/pages.yml`). No server: the page talks to an Electrum server over WebSocket and to the
WizardConnect relay; for the demo tools it runs the 402 paywall (`LeashPaywall`) inside the page, so payments are
real chipnet transactions broadcast by the page. In production the paywall is a server (`src/http.ts`); the HTTP
message shape is the same.

What a judge can do in about a minute, without coins and without a wallet:

| # | Click | What happens on chain |
|---|---|---|
| 0 | "Run the agent" / "Run until the leash says no" | the demo agent (same loop as `npm run agent`, scripted planner) works through its goal: plan, 402, payment, answer, per step with txids; the long run ends with the refusal before signing |
| 1 | open the page | the **public demo leash** loads: 12 000 sats per 6 blocks, one allowed payee (the demo tool); balance and window are read from the chain |
| 2 | "Chain tip" / "BCH price" / "Agent fortune" | the agent gets `402`, signs a covenant payment with an `LSH1` receipt bound to the request, the tool settles it and answers; the payment txid is shown and the gauge moves |
| 3 | "Try to break it": any of 5 attacks | the page signs a raw transaction with the (published) agent key that breaks one rule and broadcasts it; the node's refusal is shown verbatim, plus the contract `require` that failed |
| 4 | keep buying | near the limit the SDK refuses before signing: `limit exceeded ... N left`; the window reopens after 6 blocks |
| 5 | "Create your own" | connect a wallet over WizardConnect (QR or pasted code) or use a chipnet-only browser key, set budget / window / fee cap / payees, create; then top up and withdraw as the owner |

The demo leash's **agent key is public on purpose**: whoever holds it can still only pay the allow-listed demo tool,
at most the window limit, fees included. That is the claim of the project, made testable by anyone. The owner key
is not published (`scripts/demo-leash.ts` creates and tops up the demo leash).

Network flag: `?net=chipnet` (default) / `?net=mainnet`. Mainnet is locked unless the site is built with
`VITE_ALLOW_MAINNET=1`; unlocked, it caps the fund at 200 000 sats and the limit at 50 000 sats and offers no
browser-held owner key (WizardConnect only).

**Keys in the browser (chipnet only):** the page keeps the leashes you create, the chipnet browser owner key and the
agent keys in `localStorage` of `ttimesai-star.github.io`. That origin is shared by every GitHub Pages site of the
account, so any of them could read those keys. Fine for chipnet coins; before a mainnet build
(`VITE_ALLOW_MAINNET=1`) the page must move to a dedicated domain, and owner keys stay in the wallet (WizardConnect).

How the page was tested (16.10.2026, headless Chromium against the built site and real chipnet):

| Path | Result | txids |
|---|---|---|
| judge path on the public demo leash: tool payment, 5 attacks, journal | payment settled; recipient / overspend / fee / fakereset rejected by the node (`mandatory-script-verify-flag-failed`), clock rejected by consensus (`non-BIP68-final`) | demo genesis `a4675bc1f9144cd05327aede4b2349633b0f5184b77bdf27234ba65e7569c2e0`, payment `4928c5aa…4290059f` |
| **agent autopilot** on the live site (GitHub Pages), 16.10.2026 22:32 Minsk: "Run the agent (3 tools)" on the public demo leash | 3 payments over 402 in 12 s, each settled and answered; window 0 → 5 215 of 12 000 sats; earlier the same button on a used-up window showed the refusal before signing | `a452479368c0f17a6ebc09c1bca28c4979eb2169705f017ac9acbe3b1e867467`, `d06f0939f8cebbc48efb8ecac88f96632bc4098d638f87516eaa907df8d5cc3b`, `fa68b521105ef72828668c1dbd2fc6eb305f0d0ecc184dfac360e22dda50cb18` |
| owner via **WizardConnect**: the page (dapp) and a headless HD wallet (`scripts/wc-test-wallet.ts`) over the public relays | prepare-coin and genesis signed by the wallet, checked by the page (`verifySigned` against the requested tx + VM) and accepted; second run: genesis and withdraw | `891e296a…`, `3257b032…`; `385d5587…`, `ae135ff5…` |
| owner via browser key (chipnet): create, agent pays a tool, top up, withdraw | all accepted | `f6af1690…`, `4e7b9bcf…`, `536f3b07…`, `8e654929…` |

Not yet tested with the page: the real Cashonize web, Selene and Paytaca apps (needs a person with the wallet; the
protocol path is the one the headless wallet exercised). Electrum: `chipnet.bch.ninja` sometimes times out a WebSocket
connect, so the page (and the agent script) use `FailoverProvider` (`src/failover.ts`): a connection failure or a hang
moves the request to `chipnet.imaginary.cash` (both checked 16.10.2026); a node's refusal is never retried elsewhere.
The page holds no server of its own (static site; the 402 tool server runs in the page), so there is no backend to fall
over.

## Mainnet run (prepared, not done)

`scripts/net-run.ts` (logic in `scripts/net-run-lib.ts`, 29 tests in `test/net-run.test.ts`):

```bash
npx tsx scripts/net-run.ts <chipnet|mainnet> status                 # balances, caps, last run, mainnet confirmation string
npx tsx scripts/net-run.ts <chipnet|mainnet> run      [--broadcast] # genesis, agent pays once, attack refused, owner withdraws
npx tsx scripts/net-run.ts <chipnet|mainnet> withdraw [--broadcast] # recover an interrupted run from local/net-run-<net>.json
```

- Without `--broadcast` nothing is sent and nothing is written; every owner transaction is built and checked locally.
- **Recovery.** Before the first broadcast the run state (agent key, every contract parameter, planned txids) is
  written atomically (temp file + fsync + rename) to `local/net-run-<net>.json` (gitignored). If the process dies or
  a broadcast response is lost, `withdraw --broadcast` rebuilds the leash from that file and sweeps it back to the
  owner, or closes the run when the genesis never reached the network. A new run is refused while the last one is open.
  An empty leash closes the run only on evidence (REVIEW.md stage 4): the genesis is unknown to the network and was
  never accepted, or one of this run's withdraw txids (written to the state before sending) is known. A lagging
  server that shows an empty leash gives exit 1, not a closed run.
- **Logs:** fields named `*priv*` and the owner and agent keys (also inside error strings) are written as
  `[REDACTED]`; txids and NFT categories stay visible.
- **Exit codes:** 0 ok; 1 funds may still be on the leash (run `withdraw`); 2 refused before sending; 3 the run ended
  and the funds are back with the owner, but a demo step failed.
- **Loss ceiling before any send:** fund + self-send / genesis / withdraw fee caps <= `maxLoss` (mainnet 23 000 sats,
  absolute ceiling 25 000 sats); each fee is checked against its cap on the built transaction before broadcast.
- **Keys:** the owner address is derived from the key and must equal the one in the secrets file; the mainnet file
  must say `"network": "mainnet"` and its key must not be any key known from the chipnet secrets, chipnet runs or the
  public web demo. Use a dedicated owner key (AL-08 above).
- **Mainnet barrier:** `AGENTLEASH_MAINNET_OK=yes` (set only after the owner of the funds approved) **and**
  `--confirm-mainnet=<loss ceiling in sats>:<last 6 chars of the owner address>` (printed by `status` after the caps).
  `withdraw` needs only the env flag: it can pay only the owner. Each broadcast is logged to `scripts/<net>-run-log.jsonl`.

Chipnet rehearsal, 17.10.2026 (`scripts/chipnet-run-log.jsonl`), with the script as above:

| Step | Result | txid |
|---|---|---|
| genesis, 30 000 sats, fee 285 | accepted | `cd692bcf37c3dfd3bc82b1c30469cdc80458283eef49f335a86a7bc5dc34bab9` |
| agent pays 1 000 sats with a receipt | accepted | `6b341ff45417e5391718ce7b9089ca7f9ae5a9a340c7d1d6d77c5f2b19ae298a` |
| attack: pay a non-allow-listed address | rejected: `mandatory-script-verify-flag-failed` (local: `pay: recipient not allow-listed`) | — |
| owner withdraws 28 295 sats | accepted, run closed, exit 0 | `8d83d734ac6450b8e82de85e32cace2446c0ccb8e0a0d265b71a51c4d3126c6e` |
| crash test: genesis broadcast, process exits without recording it | `status` shows the open run; a new `run` is refused (exit 2) | `7736dc128c308cacb7c25b6e680a99a1fcb24d70db3dc7a887a9a167be38306f` |
| `withdraw --broadcast` from the state file alone | 30 000 sats back to the owner, run closed; repeated `withdraw` exits 0 | `e8ba0cc98e20269feda5e9524ebf39f69b422c9b40ed718fdff9d83502af7003` |

Rehearsal after Jules stage 4 (17.10.2026, evidence-based close, log redaction): genesis
`776215b7034b38eb57d45b9c0a713d531106a5392bce159d000a631b59fb8bd6`, payment
`a115b8e5ab1b97be71fce5efdb10efbf508d1c4194229713acf98ee4e86e28ec`, attack rejected
(`mandatory-script-verify-flag-failed`), withdraw 28 295 sats
`5238beab6a4514c68786d82f70e1802543837071fa8ff09005426f6dc3635b7d` (recorded in `withdrawAttempts` before sending),
run closed, exit 0; no key in the log.

Rehearsal after Jules stage 5 (17.10.2026, literal case-insensitive key redaction, redacted CLI errors): genesis
`0a4f3382bfae68de3dca9dc5f55a06d53a2675b0c0b8f7eab4c1fbdacefdc02b`, payment
`b3626841e4fcfc6fb997e9c03a09700155aebc3f4ce579e6dd24bbca655df15f`, attack rejected
(`mandatory-script-verify-flag-failed`), withdraw 28 295 sats
`25317a47a6505257cbfc00ce61a7afbce6beb0ffde54f8b02b7c3c3c57418a79`, run closed, exit 0; no owner or agent key in the
log or on stdout.

Earlier rehearsal (16.10.2026, previous script version): genesis `c6acbe41…`, payment `4a904e78…`, attack rejected,
withdraw `1829c12e…`.

## Related work (honest)

- **FortressVault** (BCH BLAZE 2025, 2nd place, Mainnet track): a covenant vault with a daily withdrawal limit kept in
  a mutable NFT, a rescue address, a live site and WalletConnect. The core mechanism (spending state in an NFT,
  per-period limit) is the same family as ours. What AgentLeash adds: (1) a **separate agent key** that spends on its
  own, while the owner exits without it; (2) **fees count against the limit** (fee drain is a tested attack);
  (3) the clock advances only by **network-proven UTXO age** (CSV), with the CSV masking bound; (4) **up to three
  allow-listed payees** instead of "anywhere within the limit"; (5) a per-payment **`OP_RETURN` receipt bound to the
  HTTP request** and a **402 paywall** (x402 v2 message shape, our `leash` scheme), so an agent pays for APIs by
  itself; (6) a public attack demo with the node's verbatim refusals.
- **x402 on BCH**: `@x402/bch` (PR x402-foundation/x402 #3632, open on 15.10.2026, `exact` scheme, P2PKH inputs only)
  and an independent x402-bch facilitator. Neither spends from a covenant; the `leash` scheme does. `exact` is not
  implemented here.

## Demo script (what the submission video shows)

Every scene runs on chipnet today, in the web demo and as a command. Each scene ends on a txid or a verbatim node
error from the logs in `scripts/`.

| # | Scene | Web demo / command | What the viewer sees |
|---|---|---|---|
| 1 | Owner creates a leash: budget per window, allowed payees, fee cap | "Create your own" / `scripts/chipnet.ts genesis` | genesis txid, state NFT (0, 0) |
| 2 | Agent buys an answer from a paid API | a tool button / `scripts/x402-chipnet.ts run` | 402 + challenge, the agent pays from the leash, 200 + `PAYMENT-RESPONSE` txid |
| 3 | Agent asks for more than the window allows | keep buying / same run, third call | refused **before signing**: `limit exceeded: ... left` |
| 4 | A compromised agent tries to cheat the network directly | "Try to break it" / `scripts/chipnet.ts attack <kind>` | node rejections (`mandatory-script-verify-flag-failed`, `non-BIP68-final`) |
| 5 | The window resets after N blocks | wait, buy again / `scripts/chipnet.ts pay 3000` | accepted, fresh window |
| 6 | Owner pulls the plug without the agent's key | "Withdraw everything" / `scripts/chipnet.ts withdraw` | withdraw txid, NFT burned |

Before the video: scenes 1 and 6 signed in a real wallet app (Cashonize web / Paytaca / Selene), and the capped
mainnet run above.

## Plan to BCH BLAZE submission (21.11.2026 16:00 Minsk)

| Dates | Step | Done when |
|---|---|---|
| 14-17.10 | Real wallet: Paytaca (chipnet) signs genesis, top-up and withdraw built by `toWizardSignRequest`; try Selene | Paytaca's signing code and connection manager: PASS 15.10 (`scripts/paytaca-compat.ts`). Left: one run with the app on a phone (`--phone`), then real chipnet txids signed in the app |
| 18-24.10 | Web UI: connect, create, fund, withdraw, journal, "try to break it"; separate browser entry point (`src/browser.ts`) | **done early, 16.10**: live page on chipnet (vanilla TS + Vite, `@wizardconnect/dapp`) |
| 18-24.10 | `exact` scheme next to `leash`, checked against `@x402/bch` | interop test passes |
| 25-30.10 | Agent with three paid tools (**done early, 16.10**: scripted or LLM planner, chipnet run above); presentation PDF (**draft done 16.10**); Jules review of the agent, a second-vendor review, Semgrep / npm audit / gitleaks | findings fixed or documented |
| 31.10 | Code freeze of the contract | tag |
| 01-10.11 | Mainnet: one small leash (owner funds at most ~10 USD), demo hosting | mainnet txids in this README |
| 11-17.11 | Video (no face, no voice), submission text; internal deadline 17.11 | submitted draft |
| 21.11 | Submission: mainnet tx, WizardConnect, demo | submitted |

## Roadmap

- `exact` scheme (standard P2PKH, compatible with `@x402/bch`, x402-foundation/x402 PR #3632 at `b297bc3`) next to the working `leash` scheme.
- Limits in a stablecoin CashToken (e.g. ParyonUSD) instead of sats; sliding window.
- Security review and code freeze before any mainnet deployment.
