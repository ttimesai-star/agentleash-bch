# Security and Correctness Review: AgentLeash v0

This review evaluates `contracts/AgentLeash.cash` and the associated TypeScript SDK (`src/leash.ts`, `src/state.ts`, `src/receipt.ts`) on branch `review/agentleash-bch`.

---

## Executive Summary

No critical, high, or medium severity vulnerabilities were found that allow an agent holding **only** the agent key (not the owner key) to bypass the on-chain financial boundaries or corrupt contract state. The contract design strictly enforces input/output structural constraints, recipient lockings, miner fee caps, state NFT capability preservation, and BIP68 relative locktimes.

Several low and informational findings were identified in SDK edge cases, transaction building semantics, and wallet integration requirements. **No new exploitable vulnerabilities were identified in the second adversarial pass.**

---

## Findings Summary Table

| Finding ID | Title | Severity | Evidence (Test Name) | Status / Impact |
|---|---|---|---|---|
| **AL-01** | Fixed-Window Reset Boundary (2x Limit) | Info | `documents fixed-window boundary: 2x limit across window reset (intended behavior)` | Verified as documented design limit |
| **AL-02** | Prohibited Token Outputs on Recipient & Receipt Slots | Info / Defense | `token outputs prohibited on payment output (out[1]) and receipt output (out[2])` | Defended by contract checks (`tokenCategory == 0x`) |
| **AL-03** | 0-Conf Clock Interaction & Unconfirmed Chains | Info / Defense | `interaction of unconfirmed chains (0-conf) with the clock` | Defended by contract CSV age checks (`this.age >= elapsedAdd`) |
| **AL-04** | Potential Dust Output Shift in `withAutoFee` Probe Pass | Low | `documents withAutoFee edge case: change output dust boundary shift between probe and final pass` | SDK fee estimation edge case if change sits near dust threshold (546 sat); Fixed in src/leash.ts |
| **AL-05** | Parameter Collision Resistance in Receipt Request Hashing | Info / Defense | `prevents parameter collision between different nonce/method/url combinations` | Defended by length-prefixed domain separation in `computeRequestHash` |
| **AL-06** | Stray Token Sweeping Requirement for Contract Usability | Low | `stray tokens on contract do not lock out the owner` | Fixed in src/leash.ts (`buildWithdraw` forwards stray tokens) |
| **AL-07** | Outflow Calculation Satoshis Preservation | Info / Defense | `(3a) Outflow calculation matches actual satoshis leaving contract` | Verified; outflow strictly accounts for payment amount plus miner fee |
| **AL-08** | Owner Path Signature Hash (`SIGHASH_ALL`) Requirement | Info / Operational | `(3b) owner() path signature hash analysis (SIGHASH_ALL requirement)` | Wallet operational requirement: owner must sign owner inputs with `SIGHASH_ALL` |
| **AL-09** | Recipient Covenant / P2SH Recycling Risk | Info / Config Risk | `(3c) Agent paying to allow-listed recipient that is a covenant/P2SH contract` | Operational config risk: allow-listed recipient addresses must be trusted |
| **AL-10** | Transaction Version and Locktime Semantics | Info / Defense | `(3d) tx.version and locktime mechanics` | Verified; BIP68 CSV semantics correctly enforced under tx.version 2 |

---

## Detailed Findings

### AL-01: Fixed-Window Reset Boundary (2x Limit)
- **Severity**: Info
- **Evidence**: `documents fixed-window boundary: 2x limit across window reset (intended behavior)`
- **Analysis**: As documented in `README.md`, if the agent spends `limit` satoshis near the end of a window and `limit` satoshis immediately after the clock advances by `period` blocks, up to `2 * limit` satoshis can be spent within a short real-time span.
- **Contract Mechanics**: The contract requires `newElapsed >= period` before resetting `newElapsed = 0` and `newSpent = outflow`. The clock cannot be advanced faster than real block time due to `this.age >= elapsedAdd`.
- **Suggested Fix / Recommendation**: None required for contract; callers/applications should be aware of fixed-window dynamics versus sliding-window dynamics.

---

### AL-02: Prohibited Token Outputs on Recipient & Receipt Slots
- **Severity**: Info / Defense
- **Evidence**: `token outputs prohibited on payment output (out[1]) and receipt output (out[2])`
- **Analysis**: Checked whether an agent could attach fungible tokens or unexpected NFTs to output 1 (payment) or output 2 (receipt) to bypass token tracking or burn token assets.
- **Contract Mechanics**:
  - Output 1 enforces `require(tx.outputs[1].tokenCategory == 0x, "pay: payment output carries tokens")`.
  - Output 2 enforces `require(tx.outputs[2].tokenCategory == 0x, "pay: receipt carries tokens")`.
- **Suggested Fix / Recommendation**: No change needed. On-chain rules strictly prohibit tokens on outputs 1 and 2.

---

### AL-03: 0-Conf Clock Interaction & Unconfirmed Chains
- **Severity**: Info / Defense
- **Evidence**: `interaction of unconfirmed chains (0-conf) with the clock`
- **Analysis**: Evaluated whether unconfirmed transactions in mempool chains could allow an agent to manipulate `elapsedAdd` or reset the clock prematurely.
- **Contract Mechanics**:
  - `elapsedAdd = 0` is valid on 0-conf state UTXOs and leaves `elapsed` unchanged.
  - Any `elapsedAdd > 0` requires `this.age >= elapsedAdd`, which requires relative locktime confirmation in a block. Unconfirmed UTXOs have age 0, so any transaction attempting `elapsedAdd > 0` on 0-conf UTXOs fails script verification.
- **Suggested Fix / Recommendation**: No change needed.

---

### AL-04: Dust Boundary Shift in `withAutoFee` Probe Pass
- **Severity**: Low
- **Evidence**: `documents withAutoFee edge case: change output dust boundary shift between probe and final pass`
- **Analysis**: `withAutoFee` in `src/leash.ts` builds a transaction with a probe fee (2000 sat), measures the serialized byte size, calculates `fee = ceil(size * feeRate) + margin`, and rebuilds with the calculated fee.
- **Edge Case**: If the owner change output value is slightly above the dust threshold (546 sat) during the 2000 sat probe pass, but drops below 546 sat after subtracting the final recalculated fee, `TransactionBuilder` or `buildTopUp` / `buildGenesis` may throw or produce an unexpected output layout difference.
- **Suggested Fix / Recommendation**: In `src/leash.ts`, re-check change dust boundaries explicitly after fee calculation or adjust probe fee estimation to account for change output presence changes.

---

### AL-05: Parameter Collision Resistance in Receipt Request Hashing
- **Severity**: Info / Defense
- **Evidence**: `prevents parameter collision between different nonce/method/url combinations`
- **Analysis**: Evaluated `computeRequestHash` in `src/receipt.ts` for collision resistance when concatenating fields (`challengeNonce`, `method`, `url`, `body`).
- **SDK Mechanics**: Each string/byte field is length-prefixed (1 byte for nonce length, 1 byte for method length, 2 bytes BE for URL length) before hashing.
- **Suggested Fix / Recommendation**: No change needed. Length prefixes guarantee unique byte representations across distinct parameter tuples.

---

### AL-06: Stray Token Sweeping Requirement for Contract Usability
- **Severity**: Low
- **Evidence**: `stray tokens on contract do not lock out the owner`
- **Analysis**: If a third party sends stray tokens to the leash contract address, `pay()` rejects the state input if extra token inputs/outputs are present. The owner can spend stray token UTXOs via `owner()`.
- **SDK Mechanics**: When building a custom transaction for stray token UTXOs, the output must carry the token details (`token: { category, amount }`) to satisfy consensus token preservation rules. `getUtxos()` correctly classifies these as `invalid`.
- **Suggested Fix / Recommendation**: Consider adding a helper method in `AgentLeash` SDK specifically for owner stray token sweeping.

---

### AL-07: Outflow Calculation Satoshis Preservation
- **Severity**: Info / Defense
- **Evidence**: `(3a) Outflow calculation matches actual satoshis leaving contract`
- **Analysis**: Evaluated whether an agent could construct a transaction where `outflow = tx.inputs[0].value - tx.outputs[0].value` computes a value smaller than the actual satoshis leaving the contract.
- **Contract Mechanics**: `pay()` enforces exactly 1 input (`tx.inputs.length == 1`), which is the contract itself (`this.activeInputIndex == 0`), and exactly 3 outputs (`tx.outputs.length == 3`). Output 0 returns to the contract address, output 1 goes to an allow-listed recipient with value `amount`, and output 2 is an OP_RETURN receipt carrying 0 satoshis. By conservation of satoshis in Bitcoin consensus:
  `tx.inputs[0].value = tx.outputs[0].value + tx.outputs[1].value (amount) + tx.outputs[2].value (0) + miner_fee`
  `outflow = tx.inputs[0].value - tx.outputs[0].value = amount + miner_fee`
  Thus, `outflow` precisely captures every satoshi exiting the contract. No satoshis can leave the contract unaccounted for.
- **Suggested Fix / Recommendation**: No change needed.

---

### AL-08: Owner Path Signature Hash (`SIGHASH_ALL`) Requirement
- **Severity**: Info / Operational
- **Evidence**: `(3b) owner() path signature hash analysis (SIGHASH_ALL requirement)`
- **Analysis**: `owner(int ownerInputIndex)` checks `tx.inputs[ownerInputIndex].lockingBytecode == ownerLock`. If an owner signs their owner input with a non-default signature hash (e.g. `SIGHASH_NONE`, `SIGHASH_SINGLE`, or `ANYONECANPAY`), the owner input could be detached or outputs malleated by third parties or the agent.
- **Impact & Wallet Requirement**: If the owner signs with `SIGHASH_NONE`, an eavesdropper can strip or modify outputs to steal withdrawn funds. Owners and wallet software interacting with `owner()` MUST sign owner UTXO inputs with `SIGHASH_ALL` (or `SIGHASH_ALL | SIGHASH_UTXOS`). CashScript SDK's `SignatureTemplate` defaults to `SIGHASH_ALL`, ensuring safe default transaction construction.
- **Suggested Fix / Recommendation**: Document the explicit requirement that owner wallet software MUST use `SIGHASH_ALL` when signing inputs for `owner()`.

---

### AL-09: Recipient Covenant / P2SH Recycling Risk
- **Severity**: Info / Config Risk
- **Evidence**: `(3c) Agent paying to allow-listed recipient that is a covenant/P2SH contract`
- **Analysis**: Evaluated whether an allow-listed recipient (`allowA`, `allowB`, `allowC`) that is itself a covenant or P2SH address could return/recycle funds back to the agent or leash contract.
- **Impact**: This is exclusively a configuration risk. The `AgentLeash` contract enforces that payment output 1 matches an allow-listed locking bytecode. It cannot restrict what the recipient script or contract does with received funds. Owners configuring `allowA`, `allowB`, and `allowC` must ensure that allow-listed scripts represent intended recipient locking bytecodes.
- **Suggested Fix / Recommendation**: Document that configuring allow-listed addresses is a trust/config risk managed at initialization time by the owner.

---

### AL-10: Transaction Version and Locktime Semantics
- **Severity**: Info / Defense
- **Evidence**: `(3d) tx.version and locktime mechanics`
- **Analysis**: Evaluated potential interactions between `tx.version`, `tx.locktime`, and relative locktimes (`this.age >= elapsedAdd`).
- **Contract Mechanics**: Relative sequence locktimes (`OP_CHECKSEQUENCEVERIFY`) require transaction version >= 2 per BIP68 consensus rules. If `tx.version < 2`, CSV checks fail during block/mempool validation. CashScript transaction builder defaults to transaction version 2 when relative locktimes are present. `tx.locktime` (absolute locktime) operates independently of input sequence relative locktimes.
- **Suggested Fix / Recommendation**: No change needed.

---

## Area Checklists & Verification Log

### Contract Analysis (`contracts/AgentLeash.cash`)
- [x] **Limit enforcement**: Verified single and cumulative spending limits; fees strictly included in outflow calculation.
- [x] **Allow-listed recipients**: Verified recipient matching against `allowA`, `allowB`, or `allowC`.
- [x] **Max miner fee**: Verified `outflow - amount <= maxFee`.
- [x] **State NFT integrity**: Verified state category matching, `0x01` mutable capability byte, no fungible token amount, and exact 16-byte commitment format (`elapsed (8B LE) | spent (8B LE)`).
- [x] **Owner escape hatch**: Verified `owner()` index lookup `tx.inputs[ownerInputIndex].lockingBytecode == ownerLock`.
- [x] **Third-party anti-griefing**: Verified agent signature check, single-input constraint (`tx.inputs.length == 1`), and active input index (`this.activeInputIndex == 0`).
- [x] **CSV semantics**: Verified `elapsedAdd >= 0`, `elapsedAdd < 65536` (preventing bit 31 sequence disable and bit 22 time-type flags), and `this.age >= elapsedAdd`.
- [x] **Byte order**: Verified `stateCategory` VM reverse byte order requirement.
- [x] **Integer decoding**: Verified 8-byte LE slicing and CashScript int conversion.
- [x] **Output structure**: Verified exactly 3 outputs for `pay()`, receipt prefix `0x6a044c53483120` (39 bytes), and dust thresholds.
- [x] **Outflow calculation**: Verified `outflow = in[0].value - out[0].value` is exact and un-bypassable.
- [x] **Owner signature hash**: Documented requirement for `SIGHASH_ALL` on owner inputs.
- [x] **Recipient covenant risk**: Documented configuration risk for allow-listed recipient scripts.
- [x] **Version & locktime**: Verified `tx.version` >= 2 requirement for BIP68 relative locktimes.

### SDK Analysis (`src/leash.ts`, `src/state.ts`, `src/receipt.ts`)
- [x] **`withAutoFee`**: Verified probing logic and transaction size scaling.
- [x] **`nextState` mirror**: Verified exact parity between TypeScript state calculation and CashScript contract logic.
- [x] **Genesis rules**: Verified `vout === 0` constraint and single mutable NFT minting.
- [x] **Withdraw / Top-up builders**: Verified input index mapping for owner unlocker and change calculations.
- [x] **`computeRequestHash`**: Verified domain-separated hashing and length prefixing.

---

## Maintainer response (10.10.2026)

| Finding | Action |
|---|---|
| AL-01 | Accepted as designed; documented in README ("Known properties and limits") and asserted by the property test. |
| AL-02, AL-03, AL-05 | No change; defended, covered by tests. |
| AL-04 | **Fixed.** Reproduced with test `auto-fee re-measures when the change output appears only at the final fee (Jules AL-04)`: the probe at 2000 sats left no change output, the final fee did, and the build failed below 1 sat/byte. `withAutoFee` now re-measures the transaction it returns and adds one output's worth of fee when a cheaper fee creates an extra output. |
| AL-06 | **Fixed.** `buildWithdraw` forwards stray token UTXOs to a required `ownerTokenAddress` instead of burning them, and refuses without it. Test `withdraw forwards stray tokens to the owner instead of burning them (Jules AL-06)`. |
| AL-07, AL-10 | No change; defended. |
| AL-08, AL-09 | Documented as owner-side requirements in README ("Known properties and limits"). |

---

## Review log, stage 2 (402 paywall, WizardConnect), 13-15.10.2026

Every Jules patch was read, re-tested and either applied, rewritten or rejected; the commit message names what was
changed and why. Sessions are on jules.google.com/session/<id>.

| Jules session | Scope | Outcome |
|---|---|---|
| 4474447409157392796 | stage 2 security review (x402 server, WizardConnect) | dust floor `7781d93`, header case `cc7dba0`, nonce cap `b457421`, `minConfirmations` rewritten `db4164b` (the patch read a `utxo.height` field cashscript does not have, so payments were never served); duplicate / fractional `inputPaths` indices refused on both sides 15.10 (was left out on 13.10) |
| 12902502665375009200 | hardening `7781d93..db4164b` | `177831c`: txid, 429 when every nonce is in flight, poll retry accepted; "already known" broadcast and handler failure rewritten (the patch's substring match on "duplicate" also matched `bad-txns-inputs-duplicate` and would have served content for an invalid tx) |
| 3258987019283182858 | round-2 rework `cd7e729..177831c` | `e46d5d8`: retry during an in-flight broadcast gets 202, abortable confirmation wait |
| 3569125901430821836 | chipnet `minConfirmations` run | `4dce950`: Electrum errors count as 0 confirmations, Headers/tuple request headers kept, stricter testnet key guard |

---

## Review stage 3 (agent, failover), 2026-10-16

This review evaluates `src/agent.ts`, `src/failover.ts`, `src/attacks.ts`, `src/state.ts`, `src/demo-tools.ts`, `scripts/agent.ts`, and `web/src/tools.ts` + `web/src/main.ts` autopilot.

### Findings Summary (Stage 3)

1. **AL3-01: `isConnectionError` False Negative on Browser `Failed to fetch` & Nested Error Objects**
   - **Severity**: Low
   - **File:Line**: `src/failover.ts:27`
   - **Reproduction**:
     Standard browser `fetch` throws `TypeError: Failed to fetch` on network disconnection. The connection error regex matched `/fetch failed/i` (with "fetch" before "failed"), returning `false` for `"Failed to fetch"`. Additionally, when errors wrap underlying failures in `e.originalError` or `e.cause`, `isConnectionError` evaluated `String(e)` as `"[object Object]"` returning `false`. Consequently, `FailoverProvider` failed to fail over on browser fetch network errors or wrapped errors.
   - **Suggested Fix**: Update `CONNECTION` regex to match `/failed to fetch|fetch failed/i` and extract error messages recursively checking `e.originalError` and `e.cause`. Tested in `test/failover.test.ts`.

2. **AL3-02: Potential Unhandled Rejection on Timeout in `withTimeout`**
   - **Severity**: Low
   - **File:Line**: `src/failover.ts:45`
   - **Reproduction**:
     In `withTimeout`, if the underlying promise `p` times out and later rejects (e.g. a hanging socket errors out seconds after timeout), `Promise.race` has already rejected with `TimeoutError`. Because `p` had only `.finally()` attached without a `.catch()`, Node.js triggered an `UnhandledPromiseRejection`.
   - **Suggested Fix**: Attach `.catch(() => {})` to `p` inside `withTimeout` to safely swallow late rejections after timeout. Tested in `test/failover.test.ts`.

3. **AL3-03: Misleading `LimitExceededError` Message when Request `amount > limit`**
   - **Severity**: Low
   - **File:Line**: `src/state.ts:53`
   - **Reproduction**:
     When a payment request outflow `amount` exceeds the covenant limit (`amount > limit`), if `remaining > 0n` (current window not yet ended), `LimitExceededError` reported that the window resets after ~`remaining` blocks. However, even after the window resets, `amount` will still exceed `limit` and be rejected.
   - **Suggested Fix**: Update `LimitExceededError` condition to check `amount <= limit && remaining > 0n` before suggesting a window reset wait. Tested in `test/agent.test.ts`.

4. **AL3-04: CLI `--net=mainnet` Flag Parsing & API Key Redaction**
   - **Severity**: Info
   - **File:Line**: `scripts/agent.ts:33`, `src/agent.ts:344`
   - **Reproduction**:
     `opt('--net')` in `scripts/agent.ts` checked `--net mainnet` but missed `--net=mainnet` key-value format, which defaulted to `mock` instead of refusing mainnet. Furthermore, while `LlmPlanner` does not log keys, ensuring `apiKey` is explicitly redacted from any thrown LLM HTTP or network error prevents accidental key exposure.
   - **Suggested Fix**: Support `--flag=value` in `scripts/agent.ts` argument parser and redact `apiKey` in `LlmPlanner` error handling. Tested in `test/agent.test.ts`.

5. **AL3-05: `runAgent` Loop Handling of Non-SDK Call Failures**
   - **Severity**: Low
   - **File:Line**: `src/agent.ts:248`
   - **Reproduction**:
     In `runAgent`, `refusalsInRow` was reset to 0 whenever `call.outcome !== 'refused'`. If calls resulted in `call.outcome === 'failed'` (e.g. tool server network error), `refusalsInRow` reset to 0, causing `runAgent` to loop until `maxSteps` was reached instead of stopping after `maxRefusalsInRow` consecutive failures.
   - **Suggested Fix**: Reset `refusalsInRow` to 0 only on `call.outcome === 'paid'`, incrementing on both `'refused'` and `'failed'`. Tested in `test/agent.test.ts`.

---

### Verification and Compliance Checks (Stage 3)

- **Prompt-Injection & Untrusted Tool Answers Analysis**:
  Verified that untrusted tool server answers cannot compel the agent to spend beyond covenant limits or pay unapproved recipients. All payment requests strictly pass through `leashFetch` off-chain checks (`maxPrice`, `allow` list matching) and on-chain CashScript covenant constraints (`spent + outflow <= limit`, `maxFee` cap, recipient script check). Prompt injection payloads cannot bypass these cryptographic boundaries.
- **Failover & Node Refusal Verbatim Behavior**:
  Verified that node refusals (e.g., script flag failures, transaction rule rejections) are thrown verbatim without retrying on other servers. Only connection errors and timeouts trigger failover.
- **Mainnet Guard & Key Protection**:
  Confirmed that `scripts/agent.ts` strictly refuses mainnet execution and that LLM API keys are redacted from error output.
- **Test Suite Status**:
  All 186 unit tests pass green (`npm test`). Type checks pass (`npm run typecheck`, `npm run web:typecheck`).

### Maintainer response, stage 3 (16.10.2026, Jules session 2143745479377256987)

| Finding | Outcome |
|---|---|
| AL3-01 | **Accepted, rewritten.** "Failed to fetch" and other network codes added. The patch read only the innermost message (`originalError` first), so a wrapper could hide a connection error or the reverse; `isConnectionError` now checks the error and up to 3 wrapped errors and fails over if any is a connection problem. Extra test: a wrapped node refusal (`non-BIP68-final`) is still not a connection error. |
| AL3-02 | **Accepted as a safeguard.** The late rejection was already handled (the `finally`-derived promise is subscribed by `Promise.race`), so no unhandled rejection occurred; the explicit `catch` costs nothing. |
| AL3-03 | **Accepted.** A single payment above the whole limit no longer suggests waiting for a reset. |
| AL3-04 | **Accepted, fixed.** `--net=mainnet` used to fall back to `mock` silently (not unsafe, but misleading); now refused like `--net mainnet`. The patch's `split('=')[1]` cut values containing `=` (e.g. a goal); replaced by `slice`. Key redaction in LLM errors accepted (defence in depth; the key was never logged). |
| AL3-05 | **Accepted.** Failed calls count towards the stop rule like refusals; the finish text says "refused or failed calls". |

Tests: 187 (183 + 4 from this round).

## Review stage 4 (net-run hardening), 2026-10-17

Jules session 14765616950157296667 on `review/agentleash-netrun-hardening` (base d5fcabe). Jules returned a patch in the session output (no branch, no PR). Plan: (1) save `phase='genesis-sent'` before sending the genesis and close an empty-leash run only when the genesis was never sent; (2) `payee.network` check in `loadKeys`, `stateCategory` = 64 hex in `validateParams`; (3) redact private keys in logs; (4) tests.

### Maintainer response, stage 4

| Item | Outcome |
|---|---|
| 1a. `phase='genesis-sent'` saved before the genesis send | **Rejected.** Not in the delivered patch either. With this flag and rule 1b, a genesis the node explicitly refused would leave the run open for ever (exit 1 on every `withdraw`), and `rotateState` would block every later run. Whether the genesis reached the network is decided by `getRawTransaction(plannedGenesisTxid)`, which is stronger evidence than a flag written before sending. |
| 1b. Empty leash: close only if the genesis was never sent, otherwise exit 1 | **Finding accepted, fix rewritten.** The finding is right: the old code closed "leash empty: already swept" with exit 0 whenever the genesis was known, so a lagging server could close a run that still held the fund. The patch, however, never closes once the genesis was sent: if the response to our own withdraw is lost, every later `withdraw` returns 1 and the run can only be closed by editing the state file. Fix: the planned txid of each withdraw is written to the state (`withdrawAttempts`) **before** it is sent; an empty leash closes the run only on evidence: the genesis is unknown and the node never accepted it (`genesisTxid` absent), or one of this run's withdraw txids is known to the network. Otherwise exit 1 with "lagging server or swept by another tool". 3 tests (lost withdraw response, lagging server, accepted genesis that vanished); all three fail on the previous code. |
| 2a. `payee.network` in the mainnet file | **Accepted** (defence in depth; the payee address prefix was already checked). Test. |
| 2b. `stateCategory` = 64 hex | **Accepted, tightened** to lowercase only: `getUtxos` compares the category with the server's lowercase string verbatim, so an uppercase category passed by `/i` would make the state coin invisible. Test with 6 bad values. |
| 3. Redact private keys in logs | **Accepted, extended.** The patch redacted only the owner key as a whole value. `logReplacer` also redacts this run's agent key (added to `ctx.secrets` when the run is planned or its state loaded) and cuts known keys out of longer strings (error messages). Other 64-hex values are left alone on purpose: txids and NFT categories have the same shape and must stay visible in the log. Test of a full run through the real log path: no owner or agent key in any line, self-send/genesis/withdraw txids present. |

Tests: 214 (208 + 6 new; the stateCategory checks extend an existing test). No private key was ever written to a log before this round (security review 16.10, section 3); item 3 is a guard against future log lines.

## Review stage 5 (net-run stage 4 re-check), 2026-10-17

Jules session 15140641460170249557 on `review/agentleash-netrun-stage4` (commits 2e2c1f6..454e6ff). Jules returned a patch in the session output (no branch, no PR) and rated it "#Correct#" itself; every item was re-checked here.

### Maintainer response, stage 5

| Item | Outcome |
|---|---|
| 1. `logReplacer`: lower-case the secret before matching | **Accepted, rewritten** as `redactSecrets` (shared by the log replacer and the CLI error handler). The old code compared `s.toLowerCase()` with the secret as stored, so a secret added in upper case leaked; all current callers lower-case, so this is a guard. The secret is also regex-escaped: a corrupted state file with a non-hex "key" no longer throws inside the logger. Test fails on the previous code. |
| 2. `withdrawInner`: add the agent key to `ctx.secrets` before the "run already closed" log line | **Accepted.** Jules' test only checked the set; ours runs the real log path with a close reason quoting the key and fails on the previous code. |
| 3. `net-run.ts` top-level `refused:` handler redacts keys | **Accepted, simplified.** No error thrown on that path carries a key today (loadKeys/mainnetGate/usage messages), so this is defence in depth. Jules added a second set plus an extra `loadState` + `collectPrivs` in `main`; we keep one module-level set (owner key after `loadKeys`, agent key added by the lib) used by both the log replacer and the handler. |
| 4. `txKnown`: treat `not in (mempool\|blockchain\|block)` and `missing` as "transaction unknown" | **Rejected (unsafe).** "Unknown" for the planned genesis closes the run with exit 0 when `genesisTxid` was never recorded (response lost). `missing` matches server/node errors such as `bad-txns-inputs-missingorspent` or "Request missing parameter", so a transient error would close a run whose fund is on the leash. The chipnet server's real answer for an unknown txid (probed 17.10: `No such mempool or blockchain transaction. Use gettransaction for wallet transactions.`, code -5) is already matched. A pinning test with three such errors fails under the proposed regex. Jules' own test for this item was vacuous (`expect(...).toBeDefined()`). |
| 5. `stateCategory.toLowerCase()` in `paramsFromState`, `scripts/agent.ts`, `scripts/demo-leash.ts`, `web/src/store.ts` (`paramsOf`, `descriptorOf`, `fromShareHash`) | **Rejected.** No caller produces an upper-case category: genesis txids, `demo.json`, run states and share links are all written by this code from libauth's lower-case hex; the web placeholder is `'00'.repeat(32)`. A hand-edited upper-case share link is refused with a clear toast ("Cannot open leash: stateCategory must be 64 lowercase hex chars"), which is the intended fail-closed behaviour of stage 4 item 2b. The patch also lower-cased `stateCategory` in `fromShareHash` but not the descriptor `id`, leaving id and category out of step in the picker and `forget`. |
| 6. `/// <reference types="vite/client" />` in `test/review4.test.ts` | **Rejected**, not needed: `tsc --noEmit` and vitest pass without it. |

Tests: 217 (214 + 3). Chipnet rehearsal after these changes: see `scripts/chipnet-run-log.jsonl` and README.

## Review stage 6 (net-run stage 5 re-check), 2026-10-17

Jules session 6091312865871295007 on `review/agentleash-netrun-stage5` (commits 454e6ff..9fe5964). The session
completed with an empty final patch and a chat report rating all four areas "verified". Its activity log, however,
holds an intermediate patch Jules withdrew before reporting; that patch pointed at a real bug in our own code.

### Maintainer response, stage 6

| Item | Outcome |
|---|---|
| 1. `redactSecrets`: case-insensitive literal match, escaping, no ReDoS, `logReplacer` keeps txids / categories / bigints | **Agreed, no change.** Matches our tests. |
| 2. `withdrawInner`: agent key in `ctx.secrets` before the first log line about the state | **Agreed, no change.** |
| 3. `net-run.ts`: one module-level set, filled after `loadKeys`, used by the log replacer and the `refused:` handler | **Agreed, no change.** |
| 4. Report: "`404 Not Found`, `Method not found` fail the `txKnown` regex, so the run stays open" | **Report wrong; bug fixed.** The regex still had a bare `not found` alternative (and `unknown transaction`) from 16.10, so exactly these texts made `txKnown` return false and closed a run whose genesis response was lost (exit 0, fund on the leash), the failure class rejected in stage 5 item 4. `8c0c28e`: only the node's verbatim `No such mempool or blockchain transaction` counts as "unknown" (re-probed on chipnet 17.10); test with six such errors (incl. `blockchain.transaction.get: Method not found`, `unknown transaction type`) fails on the previous code. |
| 4a. Withdrawn patch: regex `(transaction\|tx\|txid)\b.*not found\|not found.*(transaction\|tx\|txid)\|no such (mempool\|blockchain\|...)* transaction` | **Rejected.** Still broad: `blockchain.transaction.get: Method not found` and `tx not found in cache, try again` match it, both server errors. A server that answers an unknown txid in other words gets exit 1 ("status unknown") instead, which is the safe side: the run stays open until a server gives the node's answer. Its test also expected `Transaction not found` to close the run, which we do not want. |
| Test count claim "218 passed" with "217 tests" | Jules ran its intermediate test; irrelevant after the revert. |

Tests: 218 (217 + 1). Chipnet rehearsal after this change: README ("Rehearsal after Jules stage 6").
