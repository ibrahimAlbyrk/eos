# Agent Backend Unification — Implementation Plan

**Status:** Active implementation plan. **Date:** 2026-06-17.
**Pairs with:** `docs/design/agent-backend-unification.md` (the *what/why*; this doc is the *how*).
**Decisions locked (by maintainer, 2026-06-17):**
1. **Consolidate** the existing canonical spine — not a from-scratch rewrite. The only "delete & rewrite" is the legacy event-ingest twin (Step C).
2. **`claude-sdk` becomes the default backend**, gated behind the SDK-default safety nets below.
3. **Implement all steps A–F**, then flip the default.

---

## 1. Working agreement (binds every step)

- **Branch:** continue on `feat/agent-sdk-backend` (this is a direct continuation of Phases 0–7).
- **Test-gate per step:** a step is "done" only when its package suites are 100% green (`cd <pkg> && npm test`). No step starts before the previous step's gate is green. (Matches the maintainer's branch-first + test-gate workflow.)
- **Commits:** hold by default; at each green gate, surface the diff + offer to commit. Never push without review.
- **PTY-safety invariant:** no step may change `claude-cli` (PTY) observable behavior until Step C (which is behavior-preserving and golden-gated). The PTY path is the SDK-default safety net — it must stay first-class and green throughout.
- **Clean-arch direction** stays lint-enforced (`contracts → core → infra → entrypoints`); new ports in `core`, adapters in `infra`. No `Date.now()` in core (use `Clock`). Node strip-only TS: explicit field+assignment, no parameter properties. `safeStringify` for non-serializable. `e instanceof Error ? e.message : String(e)` in catch.
- **Throwaway daemon for smoke tests:** `EOS_HOME=$(mktemp -d)` — never touch the production `~/.eos`.

---

## 2. Execution order & dependency graph

```
A (SDK tools work) ──► B (provider from settings) ──┐
        │                                            │
        └──► SPIKE (manual, billing/ToS) ────────────┼──► FLIP (SDK default)
                                                     │
F (conformance net) ──► C (one event pipeline) ──► D (caps + session) ──► E (typed spec + relocate)
```

- **A first** — lowest risk, highest value, and a hard prerequisite for SDK-as-default (a default backend whose tools don't work is unacceptable).
- **B second** — completes the user-facing goal (pick provider from settings); independent of the structural refactors.
- **F before C/D/E** — the cross-backend conformance net is the safety net the risky refactors lean on.
- **C → D → E** — deepest-to-widest structural cleanup, each behind the conformance net + existing lifecycle tests.
- **SPIKE** gates the FLIP, not the code: Steps A–F land regardless; flipping `defaults.*.backend` to `claude-sdk` happens only after the spike proves billing safety.

---

## 3. The blocking spike (manual — maintainer runs; gates the FLIP only)

Code-side we ship the *guards*; the spike proves the *facts* the guards assume. Run on a real subscription with a throwaway daemon. Must prove ALL before FLIP:

1. `options.env` **replaces vs overlays** the SDK child env. (If overlay: `billing-env.ts` must pass a complete explicit env, not a scrub of `process.env`.)
2. A daemon-level `ANTHROPIC_API_KEY` does **not** reach the SDK child under `buildBillingGuardEnv` (assert no key in child; one real turn bills the subscription).
3. An **assertable auth-source signal** exists (token prefix `sk-ant-oat01-…` pre-launch invariant at minimum; a post-launch signal if obtainable).
4. `canUseTool` fires for **every** Eos tool after Step A's gating change (0-bypass).
5. ToS posture re-checked (subscription-OAuth-via-SDK not actively blocked/rate-limited differently).

Spike-negative → keep `defaults.*.backend` on PTY; Steps A–F still shipped and useful.

---

## 4. Steps

### Step A — SDK tools work (the §3.1 / §5 fix)

**Goal:** an SDK orchestrator/worker uses Eos's MCP tools exactly like the PTY lane.

**Tasks (file-by-file):**
- **A1** `manager/backends/sdk/ClaudeSdkBackend.ts` — add to the `options` object (`:133-145`):
  - `systemPrompt: { type: 'preset', preset: 'claude_code', append }` when `append` is non-empty (root cause #1).
  - `settingSources: []` + `strictMcpConfig: true` (root cause #2 — isolate ambient `~/.claude` tools).
  - `allowDangerouslySkipPermissions: true` when `spec.permissionMode === 'bypassPermissions'` (else pass `permissionMode`).
- **A2** `ClaudeSdkBackendDeps` (`:44-54`) — add `assembleAppendPrompt(spec: AgentLaunchSpec): string | null`; call it in `start()` to compute `append`.
- **A3** `manager/container.ts` (~`:596-603`) — wire `assembleAppendPrompt` into `createClaudeSdkBackend`, reusing the same DPI assembly the CLI backend uses (`assembleSystemPrompt` core use-case; map `AgentLaunchSpec` → facts). Mirror `container.ts:535`.
- **A4** `manager/backends/sdk/SdkToolHost.ts` — stop auto-approving Eos tools so `canUseTool` gates every call (root cause #3). Return `allowedTools: []` (tools stay *offered* via `mcpServers`; not allow-listed ⇒ `canUseTool` fires ⇒ `PolicyGatewayService` + AskUserQuestion deny run). **Verify against `@anthropic-ai/claude-agent-sdk` `.d.ts` that SDK-provided `mcpServers` tools are offered without being in `allowedTools`** before finalizing; if the SDK requires allow-listing for availability, fall back to gating via `hooks.PreToolUse` instead.
- **A5** Tests `manager/backends/sdk/__tests__/claude-sdk.test.ts` — assert `options.systemPrompt.append` is the assembled prompt, `settingSources` is `[]`, `strictMcpConfig` is `true`, `allowDangerouslySkipPermissions` set iff bypass, and (via `FakeSdkQuery`) that a tool call reaches `canUseTool` → the policy decider.

**Gate:** `cd manager && npm test` green; `cd contracts && npm test` green (no contract change expected). Manual: throwaway-daemon SDK orchestrator spawns a worker via `mcp__orchestrator__spawn_worker`.
**Rollback:** revert the options additions; SDK reverts to today's (tool-less) behavior.

### Step B — Provider selectable from settings (§3.2 / §4.5)

**Goal:** pick the backend (incl. `claude-sdk`) from the UI; per-worker override; billing guard.

**Tasks:**
- **B1** `contracts/src/http.ts` — add `backendProfile?: string` to `SpawnWorkerRequestSchema` + `SpawnOrchestratorRequestSchema` (`:15-69`); add `GET /api/backends` (list profiles) + `PUT /workers/:id/backend {profile, cascade?}` to ROUTES; update the ROUTES snapshot test.
- **B2** `manager/routes/` — `spawn-worker.ts:42` / `orchestrators.ts:26` pass `explicitProfileName: body.backendProfile` into the resolver (lights up `SqlBackedBackendResolver.ts:32`). New `GET /api/backends` returns `Object.entries(config.backends)` → `{name, kind, model, costMode}`. New `PUT /workers/:id/backend` persists `backend_profile` (+ BFS cascade), mirroring `PUT /workers/:id/permission`.
- **B3** Billing guard — in the spawn path, if the resolved backend kind is metered-API (`anthropic-api`/`openai`/`codex`) require the profile's `costMode === 'billed'`; if a `subscription` auth resolves to `scheme:"none"`, fall back to `claude-cli` (log `sdk_auth_unavailable_fell_back_to_pty`). (SDK-default safety net.)
- **B4** `app/ui/src/settings/registry.jsx:18-22` — replace the hardcoded `PROVIDERS` with a list fetched from `GET /api/backends` (include `claude-sdk`); `app/ui/src/state/composer.jsx` + `api/client.js` send the chosen `backendProfile` on spawn. Optional: a per-worker backend switcher mirroring the permission control.
- **B5** Tests — `manager/shared/__tests__/config.test.ts` (profiles list), a route test for `/api/backends` + `/workers/:id/backend`, `app/ui` vitest for the dropdown reading real profiles.

**Gate:** `manager`, `contracts`, `app/ui` suites green. Manual: select `claude-sdk-opus` in settings → spawned worker resolves to `claude-sdk`.
**Rollback:** schema fields are optional; UI falls back to the static list.

### Step F — Cross-backend conformance net (§3.3 / ADR §9)

**Goal:** one executable guarantee that every backend emits identical canonical event sequences + identical tool projections. (Done before the risky refactors so they have a net.)

**Tasks:**
- **F1** `manager/tools/__tests__/` — golden test asserting `toMcpModule` / `toSdkTool` / `toRuntimeTool` produce identical `{name, schema, description}` sets from the same `registry.ts` defs (the §4.3 parity test). Requires F-prereq: co-locate `toSdkTool` into `projections.ts` + a single `prefixedToolName(role, name)` from `EOS_BUILTIN_MCP_SERVERS` (do this as F1a so the test has one source).
- **F2** `infra/src/__tests__/agent-backend-conformance.ts` — extend beyond port lifecycle to assert canonical event *sequences* (session→turn→message→usage→turn:ended) for `Fake`, `InProcess`, and a `FakeSdkQuery`-driven `ClaudeSdkBackend`. Add a CLI-translation test: feed representative JSONL/hook fixtures through `spawner/canonical-map.ts` and assert the same canonical vocabulary.

**Gate:** `manager`, `infra` suites green.
**Rollback:** test-only; no runtime risk.

### Step C — One event pipeline (§3.3 #1 / §4.2)

**Goal:** delete the legacy event-ingest twin; canonical events only, one persisted row type, one UI decoder.

**Tasks:**
- **C1** Make the claude-cli worker emit canonical events: move `spawner/canonical-map.ts` translation to the worker emit boundary (or have the daemon HTTP ingest translate then feed `processAgentSignal` only). Feed `processAgentSignal` exclusively.
- **C2** `core/src/use-cases/ProcessWorkerEvent.ts` — delete the parallel state machine (`HANDLERS` + the `CANONICAL_DRIVEN` hybrid at `:191-207`); keep only what `processAgentSignal` needs. Remove the stale comment at `ProcessAgentSignal.ts:6-9`.
- **C3** `contracts/src/events.ts` — demote `jsonl`/`hook`/`usage`/`tool_running` to optional raw debug sidecar; persist canonical `agent_event` as the primary row (`events.ts:80`).
- **C4** `app/ui/src/lib/messageParser.js` — delete the `jsonl` branch (`:425-483`); `agent_event` decoder (`:387-424`) becomes the only decoder.
- **C5** Tests — golden before/after: capture a representative CLI event stream pre-change, assert the canonical output + UI blocks are equivalent post-change. Update `spawner/__tests__/ingest.test.ts`, `synthesized-events.test.ts`, UI parser tests.

**Gate:** `core`, `spawner`, `manager`, `app/ui` suites green; golden CLI stream equivalent.
**Rollback:** the change is wide — gate hard on the golden capture; revert as a unit if it diverges.

### Step D — Load-bearing capabilities + session contract (§3.3 #2,#3 / §4.1)

**Goal:** route every mutation through `AgentSession`, guarded by capability; delete `kind === "claude-cli"` checks.

**Tasks:**
- **D1** `core/src/use-cases/KillWorker.ts:71-95` — terminate via `session.stop()`; keep subtree/cleanup; pids/pgrep become the out-of-process adapter's private concern.
- **D2** interrupt/keystroke/model/permission paths (`DispatchMessage.ts:92`, `dispatch-deps.ts:26`, `resume-helpers.ts:23`, `commands/handlers/interrupt-worker.ts`, `workers.ts` keystroke/model/permission) — branch on `session.capabilities.*`, not on `kind`; go through the session.
- **D3** `app/ui/src/lib/backendCaps.js` — UI receives `capabilities` as data per worker (extend the worker projection in `manager/tools/projections.ts`/worker route); delete the hardcoded kind set. Cost label reads resolved `costMode`, not a kind set.
- **D4** Delete unread capability flags or wire their consumers; reconcile `AgentBackend.ts` doc comments.

**Gate:** `core`, `manager`, `app/ui` suites green; existing `*.lifecycle`/`KillWorker.worktree` tests pass; `KillWorker` stops an in-process backend (new test).
**Rollback:** per-path; each capability gate is independent.

### Step E — Typed launch spec + adapter relocation (§3.3 #4,#5 / §4.6)

**Goal:** replace the `backendOptions` grab-bag with a typed/discriminated spec; move all adapters to `infra/`.

**Tasks:**
- **E1** `core/src/ports/AgentBackend.ts` — replace `backendOptions?: Record<string,unknown>` with a `profile: ResolvedBackend` + per-kind typed options (discriminated). Update `AgentLaunchSpec` consumers (`SpawnWorker.ts:206`, `ResumeWorker.ts`, `ClaudeCliBackend.ts:63`, `ClaudeSdkBackend.ts:120`).
- **E2** Move `ClaudeCliBackend.ts` + `manager/backends/sdk/*` → `infra/src/backends/`; their manager-local collaborators (`buildArgs`/`buildEnv`, tool registry, `PolicyGatewayService`, prompt assembler) become injected ports/deps wired in `container.ts`.
- **E3** Lint allowlist — tighten so the relocation is enforced, not silently permitted.

**Gate:** `npm run lint` (dependency direction) + all suites green.
**Rollback:** mechanical but wide; do as the last step so nothing depends on the old locations.

### FLIP — SDK as default (gated on Step A + spike)

- `manager/shared/config.ts` `DEFAULT_BACKENDS` — add `claude-sdk-opus` (`kind:"claude-sdk"`, `model:"claude-opus-4-8"`, `auth:{kind:"subscription"}`, `costMode:"included"`, `params:{thinking:{type:"adaptive",display:"summarized"}}`); set `defaults.{orchestrator,worker}.backend = "claude-sdk-opus"`.
- Guard: creds-absent → PTY fallback (Step B3) is the safety net. PTY stays first-class.
- **Only after** Step A green + the §3 spike green.

---

## 5. Test matrix (run per gate)

| Suite | Command |
|---|---|
| manager (core/spawner/services) | `cd manager && npm test` |
| contracts | `cd contracts && npm test` |
| infra | `cd infra && npm test` |
| web | `cd app/ui && npm test` |
| lint (dep direction) | `npm run lint` (root) |
| full pre-deploy | `eos build --check` |

---

## 6. Risk register (brief — full diagnosis in the unification report)

| Risk | Mitigation |
|---|---|
| SDK billing flips to API (env overlay) | `billing-env.ts` scrub + spike 1/2; PTY fallback on `scheme:"none"`. |
| ToS / OAuth-harness blocking | PTY first-class + sanctioned; spike 5; FLIP reversible by one config line. |
| Emptying `allowedTools` hides MCP tools | Verify `.d.ts` semantics in A4; fall back to `hooks.PreToolUse` gating if needed. |
| Step C breaks historical rows / UI | Canonical-alongside-legacy until the golden capture matches; raw JSONL kept as debug sidecar. |
| Wide refactor regressions (C/D/E) | Step F conformance net first; existing lifecycle tests; per-step green gate. |
| Credit-pool un-pause | `costMode` guard + reversible FLIP; re-verify at spike. |
