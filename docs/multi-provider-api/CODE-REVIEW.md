# Final Adversarial Code Review — Multi-Provider API Backend Lane

> Scope: `c75a80e..HEAD` on `feat/multi-provider-api` (docs · Q0 · M1–M6 · final-verification).
> Reviewed the ACTUAL diff + new files, not the build's self-reports. Suites spot-run:
> infra (375 pass), manager api-lane (18 pass), core guards (backend-kind-literal +
> dpi-immutable-when, 56 pass) — all green, but the green hides B1 (no test sends a 2nd
> user turn). Every finding cites `file:line`.

## VERDICT: NOT production-ready — 1 BLOCKER · 2 MAJOR · 5 MINOR.

The architecture is genuinely sound: capability-driven (no kind-branch — guard green), creds
by-reference only, the #1 reasoning round-trip hazard is correct+tested, retry/compaction/
pricing/MCP-fail-soft all land as designed. But the Eos-hosted loop **drops the assistant's
own text from history**, which hard-400s every multi-turn Anthropic session and degrades every
multi-turn session on every provider — a guaranteed defect on the lane's central use case
(an orchestrator assigned to a non-Claude model, G3). One localized loop fix clears the BLOCKER.

---

## [BLOCKER]

### B1 — `runTurn` never persists the assistant's TEXT turn → multi-turn breaks (Anthropic 400 every 2nd turn; coherence loss on all dialects). Defeats G3.

**Location:** `core/src/use-cases/ToolRuntime.ts:147-150` (no-tool-calls branch returns before
pushing) and `:156` (the tool-call assistant message stores only `turn.toolCalls`, dropping
`turn.text`). Confirmed by `manager/__tests__/api-lane-lifecycle.test.ts:203-231` (run 1's
text reply `"ack"` is never asserted persisted; run 2 sends `[user "first task", user "second
task"]` — two consecutive user messages — and only passes because the stub is permissive).

**Problem.** When the model ends a turn with text (`stopReason:"end_turn"`), the loop emits the
text as an event (`:121`) but returns `messages` **without** appending an
`{role:"assistant", content: turn.text}` message (`:147-150`). The persisted/returned
conversation therefore never contains the assistant's textual replies. On the next user turn
(`InProcessBackend.kickTurn` pushes a `user` message, `InProcessBackend.ts:140`):

- **Anthropic dialect (`anthropic-api`):** the prior turn's last history message is either a
  `tool` result (→ mapped to `role:"user"`, `AnthropicModelClient.ts:179-181`) or — for a
  text-only turn — the original user task. Appending the new user message yields **two
  consecutive `user`-role messages**, which the Messages API rejects with a hard
  `400 "messages: roles must alternate"`. So the **second message to any `anthropic-api`
  worker/orchestrator 400s** — and the orchestrator is inherently long-lived/multi-turn.
- **All dialects (openai/codex/deepseek/glm/local):** the model never sees its own prior
  answers, a real coherence regression vs the SDK/CLI lanes (which keep the full transcript);
  strict OpenAI-compatible chat templates (some vLLM/Ollama/GLM deployments) also 400 on the
  non-alternating roles.

The compactor's `coalesceUserStrings` (`DropOldestContextCompactor.ts:51-62`) would merge the
consecutive user messages — but only when compaction triggers (history over `0.9×window`), so
normal-sized multi-turn conversations are unprotected.

**Why it matters.** G3 explicitly assigns "any model to the orchestrator … interoperating
seamlessly" and durability across restart. A metered orchestrator on DeepSeek/GLM loses its
own context every turn; on `anthropic-api` it dies on turn 2. The persisted JSONL transcript
is also lossy (resume rehydrates a conversation missing every assistant answer).

**Fix.** In `runTurn`, persist the final assistant text before returning, and (for fidelity)
carry text on the tool-call message:
- At the no-tool-calls branch (`:147`): `if (turn.text) messages.push({ role: "assistant", content: turn.text });` then emit `turn ended` + return. This alone restores wire alternation
  for BOTH the text-only and tool-then-text cases (the sequence becomes
  `user → assistant(tools) → user(tool_result) → assistant(text) → user2`, which alternates),
  and is safe with `preserve-signed` (a final non-tool turn needs no thinking re-emit).
- (Follow-up, optional) also include `turn.text` alongside `turn.toolCalls` on the `:156` push
  and have `toAnthropicMessage`/`toOpenAIMessage` emit a leading text block, so intermediate
  text accompanying a tool_use isn't lost.
- Add the missing regression test: a 2nd `sendMessage` after a text-ending turn on the
  **anthropic** dialect, asserting no two consecutive `user`-role messages reach the client.

---

## [MAJOR]

### MJ1 — `InProcessBackend` has no in-flight-turn guard: a 2nd dispatch (or `/clear`) mid-turn corrupts the conversation and silently un-does the clear.

**Location:** `infra/src/backends/InProcessBackend.ts:138-152` (`kickTurn` fires
unconditionally), `:160-165` (`sendMessage` → `kickTurn` with no busy check), `:178-191`
(`clearContext`). Reachable path: `manager/routes/workers.ts:341-344` (the worker **action**
route dispatches with **no** `queueWhenBusy`) and `:299` (dashboard route passes
client-controlled `body.queueWhenBusy`). The orchestrator-directive path is safe (`:283`
sets `queueWhenBusy:true`).

**Problem.** The claude-cli/sdk lanes serialize turns in the child process/SDK queue; the
in-process lane relies entirely on upstream `queueWhenBusy` discipline and has **no internal
guard**. Two manifestations:
- **(a) Concurrent `sendMessage`.** If a 2nd message reaches a WORKING in-process worker via a
  non-queued path, `kickTurn` runs again: it pushes a `user` message onto `s.messages` and
  starts a second `runTurn` on `s.messages.slice()` while the first is still in flight. Both
  `.then` callbacks do `s.messages = msgs` (`:148`) from divergent snapshots → lost messages /
  interleaved turns; both call `store.save` → the persisted conversation is whichever settles
  last. `s.current` is overwritten so `whenSettled` tracks only the 2nd turn. The two turns
  also emit into the same FSM/SSE stream.
- **(b) `/clear` during an active turn.** `clearContext` sets `aborted=true`, clears
  `s.messages=[]`, rolls to a fresh `sessionId`, deletes the old file (`:182-188`). But the
  aborted in-flight turn's trailing `.then` (`:148`) then runs `s.messages = msgs` (the
  pre-clear messages) and `store.save(workerId, s.sessionId=fresh, msgs)` — **re-populating the
  cleared buffer and persisting stale history under the new session id**. The clear is undone.

**Why it matters.** Directive-listed "concurrent turns" hazard. Conversation integrity is the
backend's responsibility; it must not corrupt state when a caller (action button, `eos` CLI,
any HTTP client omitting `queueWhenBusy`) sends mid-turn.

**Fix.** Make `kickTurn` serialize: if `s.current` is non-null, either chain
(`s.current = s.current.then(() => runTurn(...))`) or return a busy signal so the daemon queue
holds the message. For (b), guard the persist `.then` with a per-session generation counter
(bumped by `clearContext`/`stop`) so a turn that was cleared/aborted out from under itself does
**not** overwrite `s.messages` or `store.save`.

### MJ2 — Background shells leak: the registry is never pruned and a killed in-process worker never reaps its `run_in_background` processes.

**Location:** `infra/src/tools/NodeProcessRunner.ts:28` (`bg` Map), `:58-68` (`startBackground`
adds, never deletes), `:65` (`close` sets `running=false` only), `:80-86` (`killBackground`
sets `running=false` only — no `bg.delete`). Runner is process-global
(`manager/container.ts:796`), shared across all sessions; nothing in `InProcessBackend.stop()`
or `closeSession` reaps shells.

**Problem.** Every `Bash(run_in_background:true)` leaves a permanent `bg` entry holding a dead
`ChildProcess` handle + its accumulated `stdout`/`stderr` strings — never freed on exit or
kill. Over a multi-day daemon lifetime across many workers this grows unbounded. Worse: because
the runner is global with no session→shell mapping, killing an in-process worker
(`stop()`, `:195-205`) aborts its loop but leaves its background shells **running as orphaned
children of the daemon** (the claude-cli/sdk lanes get this for free by killing the worker
process tree). `startBackground` also ignores `opts.timeoutMs` (`bash.ts:32` passes it,
`NodeProcessRunner.ts:58` never reads it), so an orphaned background job runs forever.

**Why it matters.** Directive-listed resource-safety axis ("bg shells tracked/killable; no
unbounded growth"). They are killable on explicit `KillShell`, but never auto-reaped — a memory
leak plus orphaned processes after every worker kill.

**Fix.** (1) `bg.delete(id)` in the `close` handler and after `killBackground`. (2) Track which
shell ids belong to a session (key by workerId, or have the env factory hand the backend a
reaper) and kill+evict them in `stop()`/`closeSession`. (3) Either honor `timeoutMs` for
background shells or drop the parameter from `bash.ts:32` so it isn't a false promise.

---

## [MINOR]

- **m1 — Stream abort reports `turn:error reason:"aborted"`, not a clean abort.**
  `OpenAIModelClient.ts:270` / `AnthropicModelClient.ts:337` return `stopReason:"error",
  error:"aborted"` on a mid-stream interrupt; `ToolRuntime.ts:132-144` then emits
  `turn:error`. An interrupt during streaming surfaces to the FSM/UI as an error rather than
  `turn:aborted`. Map `error:"aborted"` to the abort path (or have the loop translate it).

- **m2 — Unbounded stdout buffering in `NodeProcessRunner.run`.** `:45-46` concatenate the
  whole command output into memory with no cap (cf. `web-fetch.ts` 50k cap), so `Bash`/`Grep`/
  `Glob` on a huge-output command hold it all in daemon memory transiently. Add a max-output
  truncation.

- **m3 — A metered profile with no `capabilities` block gets neither compaction nor the
  fail-fast guard.** `in-process-env.ts:135` passes `contextWindow: capabilities?.contextWindow`
  (undefined) and `ToolRuntime.ts:90-95` needs both compactor AND capabilities — so a profile
  omitting `capabilities` grows history unbounded on a small-context local model and 400s with
  no recovery. Not a code defect (declared-data design) but validate/warn at
  `POST /api/backends` like the billed-needs-price rule, or document that a localhost
  small-context profile MUST declare `capabilities.contextWindow`.

- **m4 — `structuredOutput:"anthropic-output_config"` envelope is unverified against the live
  Anthropic API.** `structured-output.ts:57` emits `output_config.format`; gated off by default
  (`"none"`), so dormant — but a profile enabling it may 400. Confirm the real field/shape
  before advertising it.

- **m5 — `writeKeychainSecret` passes the secret in argv.** `SubscriptionAuthResolver.ts:57`
  (`security add-generic-password … -w <secret>`) is briefly visible to same-user `ps`.
  Inherent to the `security(1)` CLI (no stdin for `add-generic-password`); acceptable/known —
  note only. The key is never written to config.json/SQLite/logs/events (verified).

---

## Genuinely sound (one line each — no padding)

- **Reasoning round-trip** — Anthropic `preserve-signed` (capture at `AnthropicModelClient.ts:204-211`, carry at `ToolRuntime.ts:156`, re-emit before tool_use at `:186-188`) vs OpenAI `drop`; correct and well-tested (`reasoning-round-trip.test.ts`, both 400-mimicking).
- **Retry** — `with-retry.ts` retries only 408/429/500/502/503/529, honors `Retry-After`, exponential backoff capped, non-retryable falls straight through; not a per-provider branch.
- **Compaction matched-pair** — `DropOldestContextCompactor.groupUnits` keeps assistant+tool_results as one unit (orphan-safe), `coalesceUserStrings` preserves alternation; reactive half-window retry bounded by `reactiveCompacted` (`ToolRuntime.ts:137-142`).
- **baseUrl / keyless** — `normalizeBaseOrigin` strips trailing `/`+`/v1`; keyless omits Authorization/x-api-key; exact `<origin>/v1/...` asserted over a real socket (`api-lane-lifecycle.test.ts:169-172`).
- **Pricing (MJ2-plan)** — unknown model → known-zero + one warn, never Opus; billed profile requires a price at load + `POST /api/backends` (`config.ts:204-228`, `routes/backends.ts:61`).
- **Security / add-provider** — key to Keychain by reference, only `auth:{kind,ref}` to config.json; route under the daemon's loopback trust model; provider errors log backend/model/workerId, never the key.
- **Durability seam** — `createInProcessBackend(kind, factory, {store, ids})`, `newSessionId` injected, save at `kickTurn .then`, resume via `start({resume})`, `attach` honestly reports `isAlive()=false`; boot reconcile suspends rows with a `session_id` (`ReconcileWorkersOnBoot.ts:38`).
- **MCP** — `RuntimeMcpClient` lifecycle (connect throws → fail-soft drop, `close()` best-effort at stop); `connectRuntimeMcpTools` drops a dead server and tears down survivors; tested.
- **Task subagent** — built-ins-only child surface, `agentId` rung-0.5 gate + control-tool omission (defense-in-depth), child DPI via `subagent_type`, depth cap (2), shared abort signal, usage billed to parent.
- **SOLID / canonical names** — bare-name built-ins gate "for free"; `disallowedBuiltinToolsFor` strips Task for orchestrators; `isBlockedBuiltinTool` hard-denies AskUserQuestion/Workflow at the gate; no-kind-branch + DPI-immutable-when guards green.
- **Edit/MultiEdit** — `applyStringEdit` enforces unique/present/distinct `old_string`, fails loudly (`_shared.ts:41-55`). Built-in file/shell tools resolve absolute/`../` paths as parity with the bundled binary (`_shared.ts:3`); confinement is the gate/editRegex/permission-mode boundary, consistent across all three lanes — by design, not a defect.

---

## G1–G4 / security / resource-safety checklist

| Item | Status | Note |
|------|--------|------|
| **G1** any provider by key + local by localhost URL | **PASS** | baseUrl origin-only + keyless header omission, composed-URL + per-worker creds verified over a real socket. |
| **G2** full SDK/CLI feature set (built-ins, MCP, skills, Task) | **PASS** | 15 built-ins + MCP fail-soft + skills + Task all wired & tested; auto-trigger skills the one documented v1 cut. |
| **G3** any model on orchestrator + all scopes, in sync, survives restart | **GAP (B1)** | resolver/inheritance + restart durability sound, but multi-turn is broken (Anthropic 400 every 2nd turn; coherence loss all dialects). |
| **G4** modular / configurable / SOLID | **PASS** | new provider = config entry, new tool/command = registry entry; no kind-branch (guard green); DPI-immutable-when guard green. |
| **Security** creds by reference only (never config.json/SQLite/logs/errors/events) | **PASS** | Keychain by ref; provider errors + persisted transcript carry no key; route under loopback trust. |
| **Security** add-provider route gated + baseUrl validated | **PASS** | `z.string().url()` + origin normalization; loopback/ui-token like every mutation route. |
| **Resource** MCP closed on stop/error | **PASS** | fail-soft connect-drop + `closeSession`/`stop` teardown. |
| **Resource** bg shells tracked/killable, no unbounded growth | **GAP (MJ2)** | killable via KillShell, but registry never pruned + no reap on worker kill (orphaned processes + memory leak); no bg timeout. |
| **Resource** AbortSignal honored | **PARTIAL** | streaming interruptible between chunks; non-streaming `createTurn` + retry-backoff sleep not cancellable mid-flight (documented M1–M3 limit); abort mislabeled as error (m1). |
| **Robustness** matched-pair compaction, retry-only-retryable, dead-MCP fail-soft | **PASS** | verified above. |

---

## Re-review (round 2) — fix commit `45cb447`

> Focused re-review of the fixer's diff (`git diff 523e91e..45cb447`) + the new regression
> tests. Re-verified the fix logic AND hunted for regressions/new issues. Suites re-run:
> core **759**, infra **382** (+7 new), manager api-lane+config **42**, api-lane-commands **6** —
> all green, no regression. The new tests genuinely reproduce each bug pre-fix.

### FINAL VERDICT: **production-ready.** 0 BLOCKER · 0 MAJOR remaining. The 1 BLOCKER + 2 MAJOR are genuinely resolved (correct logic + true reproductions); 2 new MINOR residuals (N1, N2), neither gating.

### Per-finding

- **B1 — RESOLVED.** `ToolRuntime.ts:156-159` now pushes `{role:"assistant", content: turn.text}`
  on the terminal no-tool-call path only (not double-pushed; the tool-call push at `:163` is a
  separate iteration). `InProcessBackend-multiturn.test.ts` uses a STRICT Anthropic stub that
  400s on consecutive user roles — fails pre-fix, passes after, asserting `sawRoles[1] ===
  ["user","assistant","user"]`. Reasoning round-trip intact: the terminal turn carries no
  `providerMetadata` (correctly — a non-tool turn needs no signed-thinking re-emit), and the
  multiturn test runs under `preserve-signed` caps. Durability test strengthened to confirm the
  assistant reply is persisted (`stored.length 3→4`, `stored[3]` = the reply) and rehydrated.

- **MJ1 — RESOLVED.** `InProcessBackend.ts:144-173`: a new turn chains on `s.current`
  (`(s.current ?? resolve).then(run, run)`) instead of starting a concurrent `runTurn` — test
  proves a mid-flight 2nd dispatch waits and then sees turn 1's reply (`seen[1] ===
  ["first","r1","second"]`, serialized, not lost). The generation counter (bumped by
  `clearContext`/`stop`, `:203`/`:222`) makes a cleared/stopped turn's persist a no-op
  (`:163` `if (s.generation !== gen) return`) — test proves `/clear` mid-turn is not undone
  (`store.load(freshId) === null`). No deadlock/livelock (`s.current` always resolves; `.finally`
  nulls it); normal multi-turn persists unaffected (only clear/stop bump the counter).

- **MJ2 — RESOLVED.** `NodeProcessRunner` tags each shell with `owner`; `reap(owner)` kills+evicts
  exactly that session's shells, wired to `env.closeSession` for BOTH kinds
  (`container.ts:997,1014` → `in-process-env.ts:140-146` → `stop()`), and the Task child reaps
  `childId` in a `finally` (`container.ts:939-949`); `owner=spec.workerId` threaded
  (`:828,852`). `timeoutMs` now honored for background shells (timer set/cleared on
  close/error/kill/reap); `readBackground` returns the final output BEFORE evicting a finished
  shell (no output loss — `NodeProcessRunner.test.ts` confirms); `killBackground`/`reap` evict;
  output capped at 5 MB/stream (m2). Map-mutation-during-iteration in `reap` is safe.

- **MINORs.** m1 RESOLVED+tested (`ToolRuntime.ts:133-140` maps `error:"aborted"` → `turn:aborted`;
  exact-match, only the interrupt path produces it). m2 RESOLVED (`MAX_OUTPUT_CHARS`). m3 RESOLVED
  (`routes/backends.ts:64-72` warns when a profile declares no `capabilities`; non-fatal).
  m4 NOTED-not-fixed (dormant `anthropic-output_config` flagged in-code, acceptable). m5
  NOTED-not-fixed (argv key exposure documented as inherent to `security(1)`, acceptable).

### New findings (round 2) — both MINOR, non-blocking

- **[MINOR] N1 — Evict-on-drain changes BashOutput re-poll semantics.** The draining read that
  observes completion evicts the shell (`NodeProcessRunner.ts:95-99`), so a redundant
  `BashOutput` re-poll returns `null` → `bash-output.ts:23` throws `no background shell with id`
  rather than a benign "completed, no new output." The model normally stops at
  `[status: completed]`, and `executeGated` catches the throw into an error tool_result, so it
  never crashes — but it's a small parity deviation vs the bundled binary. Also: a finished bg
  shell that is *never* re-read is retained until session `reap` (bounded by stop). *Optional:*
  retain a completed shell for one extra benign read, or treat an unknown id as
  completed-no-output. Not blocking.

- **[MINOR] N2 — reap SIGKILLs the shell PID, not a detached descendant tree (pre-existing, not a
  regression).** `spawn(..., {detached:false})` + `child.kill("SIGKILL")` kills `/bin/sh`; for a
  compound/backgrounding command (`a & b`, pipelines) that leaves the shell resident, forked
  grandchildren can still orphan. This is strictly *better* than before (the shell itself is now
  killed) and matches the foreground `run()` behavior, so it is not introduced by this fix — but
  MJ2's "no orphaned children" goal is only fully met for the common exec-replaced single-command
  case. *Optional:* `detached:true` + `process.kill(-pid)` to kill the whole group. Not blocking.

### Regression / soundness checks
- All four suites green; the durability-test edits *strengthen* assertions (persist+rehydrate the
  assistant turn), they do not weaken to hide a regression.
- The `fakeProc` in `api-lane-commands.test.ts:26` lacks `reap()` but `reap` is never called on it
  (command-expander uses only `proc.run`); suite passes. Harmless.
- No new BLOCKER/MAJOR. Serialization is deadlock-free, the generation guard drops no legitimate
  persist, reap is ownership-scoped (no cross-worker kill), eviction loses no output.
