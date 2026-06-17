# Unified Agent Backend — Cleanup, Single Interface & Provider Selection

**Status:** Design report (no implementation). **Date:** 2026-06-17.
**Audience:** Eos maintainer. **Prereqs:** builds on `docs/adr/0001-backend-agnostic-agent-platform.md` (the vision) and `docs/design/agent-sdk-backend-migration-plan.md` (the SDK build plan). This document does **not** replace them — it diagnoses where the *implementation* (branch `feat/agent-sdk-backend`, Phases 0–7) drifted from them and specifies the consolidation that delivers the three things you asked for:

1. **One clean interface for agents**, behind which CLI / SDK / API providers are interchangeable.
2. **Provider selectable from settings** (not a hand-edited `config.json` + restart).
3. **Every tool works identically on every backend.**

All load-bearing claims are grounded in `file:line` from a six-lane read of the codebase.

---

## 0. Executive summary

**You do not need a from-scratch rewrite. The architecture is right; the implementation is half-migrated.** Your own ADR (§3 "two backend families", §6.2 "the daemon never sees a hook/jsonl event again") and the SDK migration plan describe a clean canonical spine. The code on this branch built most of that spine — and it is genuinely good in places — but stopped at a **hybrid** state where the old and new worlds run side by side. That coexistence is the "karman çorman" (messy) feeling, and it is the direct cause of all three reported problems.

The single sentence that explains the mess:

> There is supposed to be **one** seam (`AgentBackend`), **one** event contract (`AgentEvent`), and **one** tool registry — but in practice there are **two** event pipelines, **three** structurally-unrelated backend implementations, tool projections scattered across **three** files, and **seven** capability flags that almost nobody reads. Consumers route *around* the seam by checking `kind === "claude-cli"`.

The three reported problems map cleanly onto this:

| Reported problem | Root cause (one line) | Where |
|---|---|---|
| **Tools don't work in SDK** | The SDK backend never sends Eos's system prompt, never isolates the tool surface, and its policy gate is dead code — so the agent has the tools but no instructions and a polluted toolset. | §3.1 |
| **Can't change provider from settings** | The Settings → Provider dropdown is a **write-only stub** no server code reads; no spawn request carries a backend choice; the resolver's per-request override is never populated. | §3.2 |
| **Code is messy** | A half-finished migration: two event-ingest state machines, capabilities declared-but-unconsumed, the session contract bypassed for kill/interrupt, and adapters split across `manager/` and `infra/`. | §3.3 |

**The plan:** consolidate to the single spine the ADR already specified (§4), fix the SDK backend's four concrete gaps (§5), and add the missing UI↔config bridge for provider selection (§3.2 → §4.5). This is **surgical**, behavior-preserving for the PTY path, and re-uses the verified machinery — not a teardown.

**One strategic decision frames everything (§2):** the Agent SDK's subscription billing is *currently working but on legally/operationally thin ice*. Keep `claude-cli` (PTY) as the **default and sanctioned** subscription path; treat `claude-sdk` as a first-class *selectable* backend, not the default. You said you want to keep the CLI — that instinct is correct and the architecture must encode it.

---

## 1. What you actually have today

### 1.1 The good spine (keep, don't rewrite)

These are well-factored and are the foundation the consolidation builds on:

- **Canonical `AgentEvent`** (`contracts/src/canonical.ts:149`) — a backend-neutral discriminated union: `message` / `delta` / `turn` / `activity` / `usage` / `session` / `permission_request` / `question_request`, with `text`/`reasoning`/`tool_call`/`tool_result` content blocks and a synthesized `blockId` for live-streaming reconciliation. This is the genuine unifying contract.
- **`ToolDefinition` + `ctx.api()` seam** (`manager/tools/types.ts:20-32`) — every one of the 12 tools reaches the daemon *only* through `ctx.api(method, path, body)`. No handler imports a service, DB, or bus. This is what makes a tool body run unchanged in a separate MCP subprocess *and* in-process. The migration off the old per-server tool files is **complete** (the old `worker-mcp/tools/*`, `orchestrator-mcp/tools/*` are deleted).
- **`ModelClient` + `ToolRuntime`** (`core/src/ports/ModelClient.ts`, `core/src/use-cases/ToolRuntime.ts`) — a clean, pure, fetch-injectable Eos-hosted agent loop with a single tool-gating chokepoint. Correct for the raw-API lane.
- **`AuthResolver` + billing-env scrub** (`core/src/ports/AuthResolver.ts`, `manager/backends/sdk/billing-env.ts:20-29`) — lazy, never-persisted credential resolution; strips `ANTHROPIC_API_KEY`/`AUTH_TOKEN` and injects the OAuth token. The subscription-billing guard is real.
- **`SqlBackedBackendResolver`** (`core/src/services/SqlBackedBackendResolver.ts:30-58`) — per-worker backend selection with a clean 4-tier precedence (explicit → inherited-from-parent → role-default → global-default), persisted via `backend_kind`/`backend_profile` columns. Ready; just under-fed (§3.2).
- **The `AgentBackend` port shapes** (`core/src/ports/AgentBackend.ts`) — `WorkerHandle` as a tagged union, `AgentCapabilities` as data, `AgentSession` with the full control contract. The *shapes* are right; they're just not *consumed* consistently (§3.3).

### 1.2 The three backend families (the structural problem)

Behind the one `AgentBackend` port live three implementations that share almost no structure:

| Family | Impl | Location | Loop owner | Events via | Tools via |
|---|---|---|---|---|---|
| **claude-cli** (PTY) | `ClaudeCliBackend` | `manager/backends/` | the `claude` TUI | HTTP POST → legacy `processWorkerEvent` | external MCP subprocess |
| **claude-sdk** | `ClaudeSdkBackend` | `manager/backends/sdk/` | the SDK's `query()` | `onEvent` → `processAgentSignal` | in-process `createSdkMcpServer` |
| **in-process API** | `InProcessBackend` | `infra/src/backends/` | Eos `ToolRuntime` | `onEvent` → `processAgentSignal` | `ToolRuntime` registry |

The ADR (§3) *anticipated* this as "two backend families" (self-driving vs Eos-driven) and that is fine in principle. The problem is the implementation made them **diverge** instead of **converge**: two event pipelines, two persisted-row vocabularies, two UI decoders, and a capability matrix nobody reads. Details follow.

---

## 2. The billing & ToS reality (the decision that frames the design)

Verified 2026-06-17 (WebSearch + the migration plan §4, both agree):

- **Subscription billing via the Agent SDK currently works.** Anthropic's planned 2026-06-15 move of Agent SDK / `claude -p` / third-party-app usage to a separate per-month credit pool ($20 Pro / $100–$200 Max) was **paused** — the Help Center confirms these still draw from subscription usage limits. ([techtimes](https://www.techtimes.com/articles/317625/20260602/anthropic-ends-subscription-subsidy-agents-june-15-credit-pool-replaces-flat-rate-access.htm), [digitalapplied](https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026), [Claude Help Center 15036540](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan))
- **But two standing risks make this fragile:**
  1. **The credit-pool split was paused, not cancelled.** It can be reinstated. If it is, `claude-sdk` silently moves off the subscription onto metered credits.
  2. **ToS restricts OAuth to Claude Code / Claude.ai only** (Anthropic revised the ToS in Feb 2026; they briefly blocked subscription OAuth for third-party tools in Jan 2026 and reversed after backlash). Eos-as-harness driving the SDK on a subscription OAuth token is in a **grey zone**. The **interactive PTY `claude` path is the only *sanctioned* subscription path.**

**Design consequence (non-negotiable):**

- `claude-cli` (PTY) stays the **default** and the **sanctioned** subscription backend. This is exactly your stated intent ("CLI'ı da bırakmamasını istedim").
- `claude-sdk` is a **first-class selectable** backend (you get live thinking + in-process tools), but **opt-in**, never the silent default.
- The `costMode` label is **display-only, not a guardrail** (per ADR §4 D-decisions). Add a **spawn-time hard guard**: a profile must not bill the metered API unless the user explicitly chose a `costMode:"billed"` profile — so a mis-selection fails *closed* (falls back to PTY) rather than billing silently. This is the one place I'd add enforcement the ADR deliberately removed elsewhere, because the failure mode is "surprise charges," not "exceeded a cap."

---

## 3. Diagnosis of the three reported problems

### 3.1 "Tools don't work in the SDK"

The unified tool projection itself is **correct** — an isolated probe confirmed `createSdkMcpServer` + `tool()` round-trips Eos's zod schemas to the Eos handler, and a live `query()` test showed the tool offered, called, and executed. So the bug is **not** in the projection. There are **three real root causes**, ranked by impact:

**Root cause #1 — the SDK backend never sends Eos's system prompt (dominant).**
`createClaudeCliBackend` receives the DPI-assembled prompt and passes it via `--append-system-prompt-file` (`ClaudeCliBackend.ts:67-69`, wired at `container.ts:535`). `createClaudeSdkBackend` is wired with **no prompt assembler** (`container.ts:596-603`) and `ClaudeSdkBackend.start` sets **no `systemPrompt`** (`ClaudeSdkBackend.ts:133-145`). The Eos system prompt is *where the orchestration protocol lives* — "use `mcp__orchestrator__spawn_worker`", "report via `mcp__worker__send_message_to_parent`", when to call what. An SDK agent boots with the stock `claude_code` prompt: it has the MCP tools mounted but **no instruction that they exist or when to use them**, so it doesn't use them. The SDK supports the exact fix: `systemPrompt: { type: 'preset', preset: 'claude_code', append: <assembled Eos prompt> }`.

**Root cause #2 — no tool-surface isolation; ~40 ambient tools leak in.**
The PTY lane always passes `--strict-mcp-config` (`spawner/claude-args.ts:44,72`). The SDK backend sets **neither `strictMcpConfig:true` nor `settingSources:[]`**. The live test proved the consequence: `system/init.tools` contained ~40 ambient tools from `~/.claude` (Gmail / Drive / Calendar / Notion / context7 / Task / WebFetch / **AskUserQuestion**) competing with and drowning Eos's 1–8 tools — including tools Eos hard-denies everywhere. `ENABLE_TOOL_SEARCH=false` does **not** suppress these.

**Root cause #3 — `canUseTool` is dead code for allow-listed tools.**
`SdkToolHost.ts:34-50` puts every Eos tool in `allowedTools`. Under `permissionMode:"default"` the SDK **auto-approves allow-listed tools without calling `canUseTool`** (live test: `canUseTool` fired **0 times**). So `SdkPermissionBridge`'s policy round-trip *and* the `AskUserQuestion` hard-deny (`SdkPermissionBridge.ts:26`) never run for Eos's own tools. Also: `bypassPermissions` mode needs `allowDangerouslySkipPermissions:true`, which the backend never sets — so git agents' mode is silently dropped.

> These three are exactly the gaps the migration plan's §7 anticipated but that the Phase-4 implementation left incomplete. The tool *plumbing* shipped; the *conditioning* (prompt), *isolation* (strict config), and *gating* (canUseTool wiring) did not.

### 3.2 "Can't change the provider from settings"

Backend selection **is** config-driven and the resolver works — but there is **no path from the UI to it**. Ranked causes:

1. **The Settings → Provider dropdown is a write-only stub.** `app/ui/src/settings/registry.jsx:18-22` hardcodes `PROVIDERS = [claude-cli, anthropic-api (disabled), openai (disabled)]` — `claude-sdk` isn't even listed. It writes `model.provider` to `~/.eos/settings.json` (`state/settings.jsx:41-46`), but **no server code reads `model.provider`** (grep: 0 consumers in `manager`/`core`/`infra`). You change it, it saves, nothing happens.
2. **No spawn request carries a backend choice.** `SpawnWorkerRequestSchema` / `SpawnOrchestratorRequestSchema` (`contracts/src/http.ts:15-69`) have no backend/profile field; the composer sends only `model`/`effort`/`permissionMode`/`prompt`/`cwd`.
3. **The resolver's per-request override is never populated.** `SqlBackedBackendResolver`'s top-priority branch `explicitProfileName` (`:32`) is passed by **neither** spawn route (`spawn-worker.ts:42`, `orchestrators.ts:26`). It is dead from the HTTP surface.
4. **The only working selection path is hand-editing `~/.eos/config.json` + daemon restart** (config is deep-frozen; `reloadConfig()` only re-reads disk).

So the backend machinery is ready and unused. This is a **missing bridge**, not a broken engine.

### 3.3 "The code is messy" — the structural debts

Six concrete debts, each a deviation from the ADR's stated target:

1. **Two event-ingest pipelines (the deepest debt).** The ADR §6.2 said "the daemon never sees a `hook`/`jsonl` event again." The implementation kept **both**: `processWorkerEvent` (legacy CLI wire over HTTP, `ProcessWorkerEvent.ts:191-207`) *and* `processAgentSignal` (canonical via `onEvent`). The CLI lane is **not** a canonical emitter — it's legacy wire translated *post-hoc* by `spawner/canonical-map.ts` for state purposes only, while still **persisting legacy `jsonl`/`hook`/`usage` rows**. The event log was never unified; the UI carries **two full decoders** (`messageParser.js:387` `agent_event` branch vs `:425` `jsonl` branch). A stale comment (`ProcessAgentSignal.ts:6-9`) even claims the canonical path "is NOT yet wired" while `container.ts:629` wires it live.
2. **The capability matrix is aspirational, not load-bearing.** `AgentCapabilities` has 7 flags; consumers read exactly one (`reportsMessageEvents` at `DispatchMessage.ts:181`). The real branching is done by `kind === "claude-cli"` string checks (`DispatchMessage.ts:92`, `dispatch-deps.ts:26`, `resume-helpers.ts:23`) and by `port`-presence guards. The UI re-derives capabilities from a **hardcoded kind set** (`app/ui/src/lib/backendCaps.js:17`) rather than reading actual capabilities — so a self-hosted `claude-sdk` profile with `costMode:"billed"` would be mislabeled "included."
3. **Half the session contract is bypassed.** `stop` / `interrupt` / `sendKeystroke` / model / permission switches exist on `AgentSession`, but consumers reach *around* the port to `httpWorkerClient` / `ProcessSupervisor` by port. `KillWorker.ts:71-95` is hard-wired to `ProcessSupervisor.escalateKill` + raw pids — **it cannot stop an in-process backend**. The port claims to be the single seam (`AgentBackend.ts:3-5`); it isn't.
4. **`backendOptions: Record<string,unknown>` is an untyped grab-bag.** It smuggles the entire claude-cli spec (`SpawnWorker.ts:206`), the SDK `resume`/`thinking`/`auth` (`ClaudeSdkBackend.ts:120-144`), and lane `collaborate` — defeating the "spec free of argv/env/port" goal the port's own comment states (`AgentBackend.ts:51-53`).
5. **Adapters split across layers.** `ClaudeCliBackend` / `ClaudeSdkBackend` live in `manager/` (an entrypoint) while `InProcessBackend` / model clients live in `infra/` (adapters). All five implement the same `core` port; all five are adapters. The lint allowlist lets `manager/` import freely, so the clean-architecture violation is silent.
6. **Tool projections scattered + untested for parity.** `toMcpModule` + `toRuntimeTool` are in `manager/tools/projections.ts`; `toSdkTool` is a private function in `SdkToolHost.ts:10-15`; the runtime name+schema assembly is in `container.ts:566`. Tool-name prefixing (`mcp__orchestrator__*`) is reimplemented **three times from string literals** instead of derived from `EOS_BUILTIN_MCP_SERVERS` (`contracts/src/tool-scope.ts:9`). **No test asserts the three projections produce identical names/schemas/descriptions** — the exact gap where "works on one backend, not another" hides.

---

## 4. Target architecture — one seam, one pipeline, one tool system

The north star: **`AgentBackend` is the only seam any consumer touches; every backend emits only canonical `AgentEvent`s; the only thing anyone branches on is `AgentCapabilities` (data).** Everything below serves that.

### 4.1 The one control seam — `AgentBackend` / `AgentSession`

Keep the port, but make it **load-bearing** and **typed**:

- **Replace `backendOptions: Record<string,unknown>` with a typed, discriminated launch spec.** Each backend declares its own options type; the spec carries a `profile: ResolvedBackend` (kind + model + auth + params) plus the role/prompt/cwd/permissionMode. No argv/env/port, no untyped bag. (ADR §6.1 already sketched this.)
- **Every mutating operation goes through `AgentSession`.** `KillWorker` calls `session.stop()`; interrupt calls `session.interrupt()`; keystroke/model/permission go through the session and are **guarded by capability** (`if (!session.capabilities.keystroke) hide/deny`). `ProcessSupervisor` survives only as a *private dependency of the out-of-process adapter*, never called from a use-case.
- **Capabilities are honest and consumed.** Delete any flag nobody reads, or wire its consumer. The UI receives `capabilities` as data per worker (extend the worker projection) and **stops re-deriving from `kind`** (`backendCaps.js` becomes a pure function of the data, or is deleted).

**Pattern:** Ports & Adapters (the seam), Strategy (one adapter per kind), Capability Object (feature negotiation as data, never `instanceof`/kind).

### 4.2 The one observation pipeline — canonical events only

This is the highest-leverage cleanup. Target (ADR §6.2, finally realized):

- **The claude-cli worker emits canonical `AgentEvent`s.** Move the `canonical-map.ts` translation to the **worker side** (it already runs in the worker for JSONL parsing) so the PTY child POSTs `AgentEventEnvelope`s, *or* keep translating at the daemon's HTTP ingest but feed **only** `processAgentSignal`. Either way: **delete `processWorkerEvent`'s parallel state machine.**
- **Persist one row type: `agent_event`.** Retire the legacy `jsonl`/`hook`/`usage`/`tool_running` row vocabulary (keep raw JSONL as an *optional debug sidecar* per ADR §6.2, not the primary contract).
- **The UI has one decoder.** `messageParser.js:buildBlocks` reads `agent_event` only; the `jsonl` branch is deleted. (This also retroactively fixes the migration plan's §6.4 blocker — SDK output rendering — because *every* backend now uses the same durable decoder.)
- **`onEvent` (in-process) and the HTTP ingest (out-of-process) are two *sources* feeding one *reducer*.** That's the clean shape: the transport differs by process boundary; the contract does not.

**Pattern:** Anti-Corruption Layer (each adapter translates its native protocol → canonical *inside the adapter*), Observer/event-sink (one reducer, one bus), Single Source of Truth.

**Payoff:** the three thinking-streaming fix commits (`f8f1b0a`, `8ea0f28`, `3467b4b`) were all symptoms of testing each lane in isolation. With one pipeline + the conformance net below, that class of bug stops recurring.

### 4.3 The one tool system — define once, project uniformly

- **Co-locate all three projections in `manager/tools/projections.ts`:** `toMcpModule` (CLI subprocess), `toSdkTool` (SDK in-process server — pull it out of `SdkToolHost.ts`), `toRuntimeTool` (ToolRuntime). One file is the single answer to "what does a tool look like on transport X."
- **Derive tool names from one source.** A single `prefixedToolName(role, name)` helper sourced from `EOS_BUILTIN_MCP_SERVERS` (`tool-scope.ts:9`), consumed by all three projections. No more three string-literal reimplementations.
- **Add a cross-transport parity golden test.** Fingerprint all three projections from the same `registry.ts` defs and assert identical `{name, schema, description}` sets. This is the executable guarantee that "tools work identically everywhere" — today it is **untested**.
- **Keep the `ctx.api()` HTTP-everywhere seam** (it's the part that already works). Optionally add a direct in-process `api` for the SDK/runtime lanes later (avoids loopback HTTP for every tool call), but that's an optimization, not a correctness fix.

**Pattern:** Single Definition + Multiple Projections (DRY), Adapter (per-transport projection), golden-file conformance.

### 4.4 The SDK backend, corrected (the "tools work" fix)

`ClaudeSdkBackend.start` must add the four things the CLI lane already does (detail in §5). In short: **send the assembled system prompt**, **isolate the tool surface** (`strictMcpConfig:true` + `settingSources:[]`), **make `canUseTool` actually gate** (don't allow-list Eos tools — let `canUseTool` decide every call, which is proven to fire; route it to `PolicyGatewayService`), and **honor `bypassPermissions`**.

### 4.5 Provider selection from settings (the missing bridge)

Three additions, mirroring the existing permission-mode pattern (`PUT /workers/:id/permission`):

1. **Expose configured profiles to the UI.** Add `GET /api/backends` returning `Object.keys(config.backends)` with each profile's `kind` / `model` / `costMode`. The Settings dropdown lists **real profiles** (including `claude-sdk-opus`) instead of the hardcoded three. Add `claude-sdk` to the catalog.
2. **Carry the choice on spawn.** Add `backendProfile?: string` to `SpawnWorkerRequestSchema` / `SpawnOrchestratorRequestSchema`; the composer sends the selected profile; the route passes it as `explicitProfileName` → the resolver's existing top-priority branch lights up.
3. **Per-worker override endpoint** `PUT /workers/:id/backend {profile, cascade?}`, the analog of the permission endpoint. The `backend_profile` column + parent-climb inheritance already exist; only the write path is missing. Document that for CLI/SDK it takes effect on the next spawn/resume (the process is already launched), exactly like the permission-mode "picked up at next tool-call" semantics.
4. **The billing guard (§2).** When a selected profile resolves to a metered-API kind, require explicit `costMode:"billed"` and surface a one-line spawn-time confirmation; a subscription profile whose auth resolves to `scheme:"none"` falls back to PTY (logged), never bills silently.

**Pattern:** the existing Strategy + Resolver (already built) finally fed by a real UI; Null-Object fallback (creds-absent → PTY).

### 4.6 Module layout (clean-architecture fix)

Move **all** `AgentBackend` adapters to `infra/src/backends/` — `ClaudeCliBackend` and `ClaudeSdkBackend` included. The manager-local collaborators they currently reach for (`buildArgs`, the tool registry, `PolicyGatewayService`, the prompt assembler) become **injected ports/dependencies**, not imports. `manager/container.ts` stays the composition root that wires them. This restores `contracts → core → infra → entrypoints` and makes the lint rule meaningful instead of silently bypassed.

### 4.7 Design-pattern catalog (target state)

| Pattern | Applied to |
|---|---|
| **Ports & Adapters (Hexagonal)** | `AgentBackend` / `ModelClient` / `AuthResolver` ports in `core`; all adapters in `infra` |
| **Strategy** | one adapter per `BackendKind`, selected by the resolver |
| **Registry + Abstract Factory** | `AgentBackendRegistry`; `createXBackend(deps)` factories |
| **Anti-Corruption Layer** | `SdkEventMapper`, `canonical-map`, per-provider `ModelClient` — native → canonical, *inside each adapter* |
| **Capability Object** | `AgentCapabilities` consumed by every branch point; UI gates on data |
| **Template Method** | `ToolRuntime.runTurn` for Eos-driven backends |
| **Single Definition / Multiple Projections** | `ToolDefinition` → CLI / SDK / runtime |
| **Observer / single reducer** | `onEvent` + HTTP ingest → one `processAgentSignal` |
| **Chain of Responsibility** | `PolicyGatewayService.decide` (rule → mode → default) |
| **Null Object / fallback** | unknown kind or creds-absent → `claude-cli` |
| **Bridge** | `AgentSession` abstraction vs `WorkerHandle` transport (http/inproc) |

---

## 5. The SDK backend, concretely (so tools work like CLI)

`manager/backends/sdk/ClaudeSdkBackend.ts` `start()` — change the `options` it builds (`:133-145`) and its dependencies (`container.ts:596-603`):

```ts
// 1) CONDITIONING — give the agent the orchestration protocol (root cause #1)
//    Wire assembleSystemPrompt into createClaudeSdkBackend (the CLI backend already has it).
systemPrompt: { type: 'preset', preset: 'claude_code', append: assembledEosPrompt },

// 2) ISOLATION — only Eos tools, no ambient ~/.claude tools (root cause #2)
settingSources: [],          // ignore user/project/local settings files
strictMcpConfig: true,       // mirror the CLI's --strict-mcp-config

// 3) GATING — make canUseTool the single decision authority (root cause #3)
//    Provide tools via mcpServers, but DON'T auto-approve them: leave Eos tools
//    OUT of allowedTools so canUseTool fires for every call (proven to fire when
//    not allow-listed) and routes to PolicyGatewayService + the AskUserQuestion deny.
mcpServers,                  // from buildSdkToolServers (unchanged — it works)
canUseTool: makeCanUseTool(workerId, policy),   // already built; now actually consulted

// 4) BYPASS — honor bypassPermissions workers (git agents)
...(permissionMode === 'bypassPermissions'
     ? { allowDangerouslySkipPermissions: true }
     : { permissionMode }),
```

Everything else in the SDK backend (the `SdkEventMapper` streaming/blockId logic, the `SdkToolHost` projection, the billing-env scrub) is **already correct** and stays. The fix is small and surgical — it's *conditioning + isolation + gating*, not a rewrite.

**Spike to confirm before cutover (from the migration plan §10 Phase 3, still required):** that `options.env` *replaces* rather than *overlays* the child env (so a daemon-level `ANTHROPIC_API_KEY` can't leak in and flip billing), and that `canUseTool` fires for every non-allow-listed tool including built-ins. Use a throwaway daemon (`EOS_HOME=$(mktemp -d)`).

---

## 6. Remediation roadmap

Ordered so each step is independently shippable and the PTY path never regresses. The first two steps deliver the three things you asked for; the rest are the structural cleanup.

| Step | Scope | Delivers | Risk |
|---|---|---|---|
| **A — SDK tools work** | The §5 four-line fix + wire the prompt assembler into `createClaudeSdkBackend`. Add the cross-transport tool-parity golden test (§4.3). | "Tools work identically on SDK." | **Low** — additive, PTY untouched |
| **B — Provider from settings** | `GET /api/backends`; `backendProfile` on spawn schemas + composer; `PUT /workers/:id/backend`; real dropdown incl `claude-sdk`; the billing guard (§2). | "Select provider from settings." | **Low–Med** — UI + 2 endpoints |
| **C — One event pipeline** | CLI worker emits canonical; delete `processWorkerEvent`'s state machine; persist only `agent_event`; one UI decoder (§4.2). | The biggest "messy" reduction; kills the dual-decoder + dedup-fragility class. | **Med** — touches the state machine + UI parser; gate with golden before/after event-stream capture |
| **D — Load-bearing capabilities + session contract** | Route kill/interrupt/keystroke/model/permission through `AgentSession`, guarded by capability; UI reads capabilities as data; delete unread flags (§4.1, §3.3). | Removes `kind === "claude-cli"` checks; `KillWorker` works for all backends. | **Med** — core surgery; covered by existing lifecycle tests |
| **E — Typed launch spec + adapter relocation** | Replace `backendOptions` bag with a typed/discriminated spec; move CLI/SDK adapters to `infra/`; collaborators become injected ports (§4.1, §4.6). | Restores clean-architecture direction; removes the untyped grab-bag. | **Med** — mechanical but wide |
| **F — Cross-backend conformance net** | Extend `agent-backend-conformance.ts` to assert canonical event *sequences* for **every** backend (CLI translation included), not just port lifecycle on Fake+InProcess (§3.3, ADR §9). | The executable guarantee behind "identical behavior." | **Low** — test-only |

**Recommended first slice:** A + B together (your three stated problems, low risk), then C (the deepest cleanup). D–F harden it. F should ideally precede C/D as a safety net, but can run alongside.

---

## 7. Decisions for you

These genuinely change the build and are yours to make:

1. **Rewrite vs. consolidate.** My strong recommendation: **consolidate** (this report's path). The spine is sound and verified; a from-scratch rewrite throws away working machinery (the canonical model, the tool seam, the resolver, the billing guard) and re-incurs every bug already fixed. "Delete and rewrite" is warranted only for the *two event-ingest machines* (step C) — there, deleting the legacy half is exactly right.
2. **Billing/ToS posture (§2).** Confirm: PTY stays default + sanctioned; `claude-sdk` is opt-in selectable. (Your message implies this.) The alternative — SDK as default — I'd advise against given the ToS grey zone and the paused-not-cancelled credit split.
3. **Implementation scope now.** Should I proceed to implement Step A (+B) immediately after you approve this report, or do you want to review/adjust the target first?
4. **Default profile.** Keep `defaults.*.backend` on `claude-cli-opus`, and let users opt into `claude-sdk-opus` per-spawn / per-worker — agreed?

---

## 8. Bottom line

The system feels messy because it is **mid-migration**, not mis-designed. Your ADR and SDK plan describe the right end-state; the branch built ~70% of it and stalled in a hybrid where old and new coexist. The fix is **convergence, not reconstruction**: one seam everyone uses, one canonical event pipeline (delete the legacy twin), one tool-projection module with a parity test, and the small UI↔config bridge that makes provider selection real. The "tools don't work in SDK" problem is four lines of conditioning/isolation/gating — not a tooling rewrite. Keep `claude-cli` first-class and sanctioned; make `claude-sdk` a clean, selectable peer; design the API lane behind the same seam so it drops in later with zero pipeline changes.
