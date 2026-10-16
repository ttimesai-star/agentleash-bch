# Security review — AgentLeash (BCH BLAZE 2026), 2026-10-16

Reviewer: security-reviewer agent (independent of the authors). HEAD ff5f27d, tests 187/187, AgentLeash.cash recompiled — bytecode matches the artifact. All Jules fixes (AL-04, AL-06, AL3-01…05, stage 2) present. BIP68 is not modelled in the Mock tests; verified on chipnet only.

## Verdict
- Contract `contracts/AgentLeash.cash`: **PASS**
- x402 (`src/x402.ts`, `src/x402-client.ts`): **PASS**
- SDK / agent: **PASS**
- `scripts/net-run.ts`: **WARN — fix before mainnet**
- Static (npm audit, gitleaks, Semgrep): **PASS**

## 1. Contract — PASS
- No limit bypass found: one input, exactly three outputs, tokens forbidden, fee counted inside the limit (lines 73–74), `elapsedAdd` bounded 0..65535 (lines 79–81). Fakereset closed by line 100.
- Owner path (line 106) can withdraw everything; funds can only be locked forever by losing the owner key.
- WARN (design, AL-08): `owner()` only checks that some input carries `ownerLock`. If the same owner key ever signs a partial transaction (ANYONECANPAY), it can be glued to the contract input and drain it. Use a dedicated owner address that is used nowhere else.
- WARN `src/leash.ts:97-110`: `validateParams` checks only that `ownerLock` is 25 bytes (P2PKH template not checked); any non-empty allow entry passes, including `0x51` (anyone-can-spend); agent key == owner key not rejected.

## 2. x402 — PASS
- Recipient substitution, replay and races are closed by a one-time nonce, receipt binding to nonce/method/url/body, and `pending` state until broadcast. Double spend of the same UTXO is rejected by the node.
- WARN: PAYMENT-SIGNATURE is a bearer token — require HTTPS outside localhost.
- WARN: with `minConfirmations=0` (default) owner or agent can double-spend and leave the server unpaid.
- WARN: `electrumConfirmations` (line 95) trusts a single Electrum server.

## 3. SDK / agent — PASS
- Agent key never reaches logs (grep of `scripts/*.jsonl`, console, file writes clean); LLM key redacted in errors.
- The model only chooses a tool name; recipient comes from the allow list, price capped by `maxPrice`, the contract enforces the ceiling.
- WARN: `web/src/store.ts` and `owner.ts` keep keys in localStorage on origin `ttimesai-star.github.io`, shared by every Pages site of the account. Before `VITE_ALLOW_MAINNET=1`, use a dedicated domain.

## 4. scripts/net-run.ts — WARN, fix before mainnet
1. **Serious:** `agentPriv` / `agentPkh` (lines 80, 99–105) are not persisted before the genesis broadcast (the header comment claims otherwise). If genesis is broadcast but the response is lost, `agentPkh` is lost, the contract address cannot be rebuilt, 20 000 sat are stuck. Persist pkh and key to `local/` BEFORE sending.
2. No recovery: an exception in `state()` (line 109) leaves funds on the leash; there is no `withdraw` subcommand; a failed withdraw (lines 123–124) still exits 0.
3. Lines 44–48 check `privHex` against `pkhHex` only; `owner.address` from the file is not checked — derive it from the key and compare (withdraw and change go there).
4. No guard against copying a chipnet key into the mainnet file. `~/.claude/secrets/bch_mainnet_agentleash.json` does not exist yet.
5. Line 101: the `ownerSpendTotal` check is dead (20 000 + fee never exceeds 30 000) and runs after the self-send is already broadcast. Real loss ceiling = fund + fees. The only barrier is `AGENTLEASH_MAINNET_OK`, which any script can set.
- Works: dry-run by default, address prefixes checked, `--net=mainnet` rejected for the agent, `--broadcast` on mainnet requires the flag.

## 5. Static — PASS
- `npm audit`: 0 vulnerabilities; package signatures verified; `libauth` 3.1.0-next.8 is a pre-release pulled by CashScript.
- gitleaks (history): one hit, `a6fa0ad` `test/agent.test.ts:261` — a fake test key, not a secret, removed in HEAD. Working tree: `local/wc-test-wallet.json` (test wallet relayKey, gitignored).
- The three chipnet keys from `~/.claude/secrets` are not in history. `agentPriv` in `web/src/demo.json` (commit `6182934`) is published on purpose (public chipnet demo).
- Semgrep (p/typescript, p/secrets, p/javascript): 0 findings.

## Order of work
First section 4 (persist agent key before genesis, `withdraw` subcommand, derive and compare owner address). Then `validateParams` hardening and the AL-08 note (dedicated owner address). The rest can wait until the 31.10 freeze.
