# Dimension 01 — Backend Abstraction & Session Lifecycle

Spine dimension. How a backend is *described*, *selected*, *instantiated*, and *driven* end-to-end,
and the exact completeness of the in-process / metered lane (`InProcessBackend`) measured against the
conformance suite. Cites are `file:line` against the repo at branch `feat/multi-provider-api`.

Sibling-file note: no `docs/multi-provider-api/*.md` siblings were readable at write time (directory
created by this write). Cross-dimension seams are flagged in §5; I do not deep-dive dims 2–5.

---

## 1. Summary — what this dimension covers + the load-bearing facts

This dimension is the contract + lifecycle backbone the whole multi-provider design hangs on: the
`AgentBackend`/`AgentSession`/`AgentBackendRegistry` ports, the per-kind `BackendDescriptor` +
`AgentCapabilities` metadata, the canonical `AgentEvent` union that is the universal event currency,
the resolver that picks a backend per worker, and the spawn→dispatch→events→signal→stop/resume flow.

Five load-bearing facts (each expanded + cited in §2/§3):

1. **The seam already exists and is capability-driven, not kind-driven.** Execution flows
   `AgentBackend.start()/attach()` → `AgentSession` (`core/src/ports/AgentBackend.ts:181-198`).
   Consumers branch on `descriptor.*` / `capabilities.*`; the canonical `AgentEvent` union
   (`contracts/src/canonical.ts:194-205`) drives the worker FSM via `processAgentSignal`
   (`core/src/use-cases/ProcessAgentSignal.ts`). Adding a provider = one descriptor + one adapter.

2. **The in-process / metered lane is NOT a stub — it is fully wired in production.**
   `container.ts:758-777` builds real `anthropic-api`, `openai`, and `codex` backends over
   `createInProcessBackend(...)`, each with a real `ModelClient` (`createAnthropicModelClient` /
   `createOpenAIModelClient`), the **full Eos tool surface** (`buildLaneTooling`, `container.ts:743-754`),
   and the shared policy gate (`makePolicyToolGate`). All three are registered into the backend
   registry (`container.ts:867-872`). The model clients are real HTTP transports, not stubs
   (`infra/src/backends/OpenAIModelClient.ts`, `AnthropicModelClient.ts`).

3. **`InProcessBackend` PASSES the conformance suite — but the suite is a thin universal contract.**
   The conformance harness (`infra/src/__tests__/agent-backend-conformance.ts`) asserts only 5
   universal invariants (start/sendMessage/attach/stop/onExit); `InProcessBackend(fakeModel)` is
   wired into it and passes (`agent-backend-conformance.test.ts:19-23`). It proves the *shape* of the
   adapter, **not** its lifecycle depth: no test exercises the canonical event sequence, billing
   accounting, streaming, `/clear`, restart, or the real model clients end-to-end.

4. **The single biggest lifecycle gap: in-process sessions do not survive a daemon restart.**
   The lane has `sessionStore:"none"` and emits only `session phase:"started"` — never `"ready"`
   with a `sessionId` (`infra/src/backends/InProcessBackend.ts:139`, contrast `claude-sdk` at
   `manager/backends/sdk/SdkEventMapper.ts:129`). Conversation state lives only in an in-memory
   `live` Map. On boot, `reconcileWorkersOnBoot` gates resumability on `session_id`
   (`core/src/use-cases/ReconcileWorkersOnBoot.ts:38`) and `resumeWorker` requires it
   (`core/src/use-cases/ResumeWorker.ts:52`) — so a restart marks every in-process worker `DONE`
   with no revival path. Fatal for a persistent metered orchestrator.

5. **The lane is gated off by two guards, and per-profile provider config never reaches the adapter.**
   Gates: `descriptor.enabled:false` on all three (`InProcessBackend.ts:55-57`) + the
   `costMode:"billed"` billing-intent requirement (`spawn-backend.ts:55-63`). And the resolved
   profile's `baseUrl`/`auth`/`params` are computed but dropped — only `model` + `profileName` thread
   into the spawn spec (`spawn-worker.ts:122-123`); the factory reads global `process.env`
   (`container.ts:761,771`). "Any provider by base URL / key" is therefore not yet plumbed per-worker.

Net: the API lane is ~70% built as plumbing and **passes conformance**, but is gated off, non-durable,
and not yet per-profile-configurable. The build is "turn on + harden + make durable," not "build from
scratch."

---

## 2. Current state — what exists today (cited)

### 2.1 The contract layer (`contracts/` + `core/src/ports/`)

**`BackendDescriptor`** — the single source of provider facts; consumers read these, never compare a
kind literal (`core/src/ports/AgentBackend.ts:63-80`):

```ts
interface BackendDescriptor {
  readonly kind: string;
  readonly label: string;
  readonly processModel: "in-process" | "out-of-process"; // handle kind, kill/interrupt routing
  readonly billing: "subscription" | "metered";           // cost label, billing guard, creds fallback
  readonly modelSource: "request" | "profile";            // request=composer model; profile=profile-fixed
  readonly capabilities: AgentCapabilities;
  readonly models: ModelCatalogRef;                        // UI model picker source
  readonly auth: "subscription" | "apikey" | "none";
  readonly enabled: boolean;                               // selectable now vs "soon"
  readonly sessionStore: "claude-transcript" | "none";     // resumable store; "none" ⇒ no resume/handoff
}
```

**`AgentCapabilities`** — capability negotiation; ISP-clean optional flags
(`AgentBackend.ts:21-51`): `interrupt`, `keystroke`, `rewind`, `runtimeModelSwitch`,
`runtimePermissionSwitch`, and optional `reportsMessageEvents`, `streamingThinking`, `resumable`,
`contextClear`. The UI/routes gate features on these flags, never on kind.

**`AgentSession`** — the live session handle (`AgentBackend.ts:138-179`). Mandatory:
`sendMessage`, `sendKeystroke`, `interrupt`, `setModel`, `stop`, `isAlive`. Optional (capability-gated,
omitted when incapable): `clearContext`, `getRewindTargets`, `rewind`, `recallLastUserTurn`.

**`AgentBackend` / `AgentBackendRegistry`** (`AgentBackend.ts:181-198`):

```ts
interface AgentBackend {
  readonly kind: string;
  readonly descriptor: BackendDescriptor;
  start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession>;
  attach(workerId: string, handle: WorkerHandle): AgentSession; // stateless re-derive
}
interface AgentBackendRegistry { get(kind): AgentBackend; has(kind): boolean; descriptors(): BackendDescriptor[]; }
```

**`AgentLaunchSpec` / `BackendLaunchOptions`** (`AgentBackend.ts:84-110`): identity + execution context,
free of argv/env/port. `backendOptions` is the typed carrier (`spec`, `resume`, `auth`, `thinking`,
`params`) — **note: no `baseUrl` field** (see §3 gap). `WorkerHandle` (`AgentBackend.ts:15-17`) is
`{kind:"http",port,pid}` for out-of-process, `{kind:"inproc",ref}` for in-process.

**`AgentStartCallbacks`** (`AgentBackend.ts:128-136`): `onSpawn`, `onExit`, and `onEvent` — the
canonical event sink for in-process backends (out-of-process leaves it unset and uses HTTP).

**Backend config model** (`contracts/src/backend.ts`): `AuthRef` (`:17-23`, a *reference* — `subscription`/`env`/`keychain`, never a raw secret), `BackendProfile` (`:25-37`: `kind`, `model`,
`baseUrl?`, `auth?`, `pricing?`, `costMode?`, `params?`), `BackendDefaults` (`:40-46`, per-role).
`BackendKind` enum is `["claude-cli","claude-sdk","anthropic-api","openai","codex"]`
(`contracts/src/canonical.ts:15-22`).

**Canonical `AgentEvent` union** — the universal currency every lane emits
(`contracts/src/canonical.ts:194-205`): `message` (blocks: text/reasoning/tool_call/tool_result/skill),
`delta` (live streaming, never persisted), `turn` (started/ended/aborted/error), `activity`
(tool_started/finished/alive), `usage` (summed → billing ledger), `context` (latest-wins occupancy
snapshot), `session` (started/ready/ended/cleared, optional `sessionId`), `permission_request`,
`question_request`. `contextTokensOf` (`:96-100`) defines occupancy.

### 2.2 Selection / resolution / billing (`core/` + `manager/shared/`)

**`SqlBackedBackendResolver.resolveForNewWorker`** (`core/src/services/SqlBackedBackendResolver.ts:35-65`)
— 4-tier precedence: (1) explicit named profile → (2) inherit nearest ancestor with an explicit backend
(parent-chain climb) → (3) role default → (4) global default `claude-cli`. Returns `ResolvedBackend`
(`core/src/ports/BackendDefaults.ts:8-16`: `kind`, `model`, `profileName`, `baseUrl?`, `pricing?`,
`costMode?`, `params?`).

**`resolveSpawnBackend`** (`manager/shared/spawn-backend.ts:15-46`) — wraps the resolver with: an
explicit UI provider pick resolved straight from the descriptor (`:21-26`, only sets `costMode:"included"`
for subscription, deliberately leaving metered unset so the guard rejects it), plus a subscription
credential safety net (`:31-44`) that falls a subscription in-process provider (claude-sdk) with no
credential back to the PTY provider — derived from descriptors, never a kind literal.

**`spawnBackendError`** (`spawn-backend.ts:55-63`) — the spawn-time guard: rejects an explicit pick of a
`!enabled` backend (`:56-57`), and rejects any metered-API selection lacking `costMode:"billed"`
(`:59-60`, via `meteredNeedsBilledIntent`).

**Billing domain** (`core/src/domain/backend-billing.ts`): `isMeteredBackend` reads `descriptor.billing`
(`:10-12`); `meteredNeedsBilledIntent` (`:16-18`) is true when a metered backend lacks the
`costMode:"billed"` opt-in.

**Backend-switch domain** (`core/src/domain/backend-switch.ts`): `canHandoffBackend` (`:21-31`) allows a
running-worker conversation handoff only when both descriptors share a non-`"none"` `sessionStore`;
`planBackendSwitch` (`:39-53`) blocks switching in busy states. **Implication: a `sessionStore:"none"`
lane can never be a switch source/target** — the metered lane is excluded from handoff by design.

### 2.3 Session lifecycle drive (`core/src/use-cases/`)

**`spawnWorker`** (`core/src/use-cases/SpawnWorker.ts:132-339`). When `deps.backend` is injected it
takes the backend path (`:237-261`): materializes the worktree daemon-side for in-process backends
(no boot child to create it, `:207-221`), calls `backend.start(spec, {onExit, onEvent})` routing events
through `deps.onAgentEvent` (`:258`), and persists `backendKind: deps.backend?.kind ?? "claude-cli"`
(`:296`). The `SpawnWorkerSpec` (`:24-88`) carries `backendProfile` (name only), `model`, `effort`,
`collaborate`, `role` — but **not** the resolved `baseUrl`/`auth`/`params`.

**`dispatchMessage`** (`core/src/use-cases/DispatchMessage.ts:157-360`). Resolves the worker's backend
by `backend_kind` (`:169-171`), reconstructs via `backend.attach(w.id, handle)` (`:299-302`), and sends
through `session.sendMessage`. `isInproc` is computed from `descriptor.processModel` (`:171`) so a
port-less in-process backend works (skips the `has no port` check, `:172`). The daemon-side chat event
(`appendChatEvent`, `:64-88`) is appended only when `!session.capabilities.reportsMessageEvents`
(`:303-304,347-349`) — in-process lanes get the daemon append; claude-cli self-reports. Slash commands
are intercepted here against `session.capabilities` (`:250-278`).

**`resumeWorker`** (`core/src/use-cases/ResumeWorker.ts:40-120`). Gated on `w.session_id` (`:52`) — only
backends that persist one (claude-cli `--resume`, claude-sdk `options.resume`) reach here. Relaunches
via `backend.start({..., backendOptions:{spec, resume:w.session_id}})` (`:76-91`). For in-process
backends it forces an IDLE settle after start (`:116-118`) since there's no PTY readiness gate.

**`processAgentSignal` / `reduceAgentSignal`** (`core/src/use-cases/ProcessAgentSignal.ts`). The FSM
reducer over canonical events: `turn` drives WORKING/IDLE + settle window (`:63-77`); `message` blocks
heal WORKING + fold task tools (`:29-48`); `session phase:"ready"` with `sessionId` →
`workers.setSessionId` (`:93-97`) — the resumability hinge; `session phase:"cleared"` resets tasks +
context tokens + settles IDLE (`:100-109`); `usage` → cost ledger (`handleUsage`, `:149-179`);
`context` → `setContextTokens` (`:136-140`); `delta` is dropped (ephemeral, `:131`).

**The in-process event sink** (`manager/container.ts:888-910`): `onAgentEvent` relays `delta` over the
`agent:delta` SSE bus topic + `turnOutput.markSeen` (`:892-898`), then funnels every other event into
`processAgentSignal`. Injected into both `spawnWorker` and `resumeWorker`. This is the complete
in-process delivery path: `InProcessBackend` `cb.onEvent` → `onAgentEvent` → FSM + cost + SSE.

**Boot reconciliation** (`core/src/use-cases/ReconcileWorkersOnBoot.ts:30-56`, wired at
`container.ts:220`): for each non-DONE/SUSPENDED row, `resumable = !wasEnding && !!session_id && !!dir
&& pathExists(dir)` (`:38`). Resumable → SUSPENDED + `clearRuntime`; else → `markDone`. It gates purely
on `session_id` (empirical), **not** on `descriptor.resumable`/`processModel`/`sessionStore`.

### 2.4 The three+one lanes as adapters

| Lane | File | processModel | billing | sessionStore | streamingThinking | reportsMessageEvents | resumable | enabled |
|---|---|---|---|---|---|---|---|---|
| claude-cli | `manager/backends/ClaudeCliBackend.ts` | out-of-process | subscription | claude-transcript | – | ✔ | – | ✔ |
| claude-sdk | `manager/backends/sdk/ClaudeSdkBackend.ts` | in-process | subscription | claude-transcript | ✔ | – | ✔ | ✔ |
| in-process metered (anthropic-api/openai/codex) | `infra/src/backends/InProcessBackend.ts` | in-process | metered | **none** | **✗ (absent)** | ✗ | **✗** | **false** |
| Fake (reference double) | `infra/src/backends/FakeAgentBackend.ts` | in-process | subscription | none | – | – | – | false |

(claude-cli/claude-sdk descriptor + capability rows confirmed by the adapter sweep:
`ClaudeCliBackend.ts:38-43` caps `keystroke/rewind/runtimePermissionSwitch/reportsMessageEvents`;
`ClaudeSdkBackend.ts:43-48` caps `streamingThinking/resumable/runtimeModelSwitch`.)

**`InProcessBackend`** (`infra/src/backends/InProcessBackend.ts`) — the API lane's engine:
- `createInProcessBackend(kind, envFactory)` (`:66`) returns an `AgentBackend` whose `live` Map holds
  `LiveSession` (`:32-39`: `messages: ModelMessage[]`, `signal:{aborted}`, `emit`, `onExit`, `env`,
  `current`).
- `start` (`:128-142`): sets `live`, fires `onSpawn({kind:"inproc",ref})`, emits
  `{type:"session",phase:"started"}`, then `kickTurn(prompt)`.
- `kickTurn` (`:73-84`): pushes the user message, runs `runTurn(...)` (the ToolRuntime loop), stores the
  returned messages. Clears the abort flag per new turn.
- `sendMessage` (`:90-95`), `interrupt` (`:97-101`, sets `signal.aborted`), `clearContext` (`:104-110`,
  drops the buffer — **emits no `session:"cleared"` event**), `setModel` (`:113`, hard no-op),
  `stop` (`:114-121`, deletes from `live`, emits `session ended outcome:killed`, `onExit(143)`),
  `attach` (`:143-145`, returns `sessionFor(workerId)` **unconditionally** — even with no live entry).
- `CAPS` (`:44-51`): `interrupt:true, keystroke:false, rewind:false, runtimeModelSwitch:false,
  runtimePermissionSwitch:false, contextClear:true`. **No `streamingThinking`, no `resumable`, no
  `reportsMessageEvents`.**
- `IN_PROCESS_DESCRIPTORS` (`:54-58`): anthropic-api/openai/codex, all `enabled:false`,
  `sessionStore:"none"`, `modelSource:"profile"`, `auth:"apikey"`.

**`ToolRuntime.runTurn`** (`core/src/use-cases/ToolRuntime.ts:37-105`) — the Eos-hosted agentic loop the
in-process lane drives: emits `turn started`, prefers `model.streamTurn` (emitting `delta`
reasoning/text) else `createTurn` (`:56-62`), closes deltas + emits durable `message` blocks (`:69-72`),
emits `usage` + `context` (`:73-81`), gates EVERY tool through `executeGated` (single fail-closed
chokepoint, `:110-131`), loops to `maxIterations` (default 50). Interrupt is cooperative — checked
between round-trips (`:43`). (Tool-execution internals are dim 2.)

**`ModelClient` port** (`core/src/ports/ModelClient.ts`): `createTurn(messages): Promise<ModelTurn>`
(required) + `streamTurn?(messages, cb)` (optional — ISP; runtime prefers it). `ModelTurn` carries
`text`/`reasoning`/`toolCalls`/`stopReason`/`usage`.

**Real model clients** (both real HTTP transports, `fetch` injectable, mappers exported for unit test):
- `createOpenAIModelClient` (`infra/src/backends/OpenAIModelClient.ts:27`) — Chat Completions; implements
  **both** `createTurn` (`:31-54`) and `streamTurn` (`:55-80`, SSE drain `parseOpenAIStream` `:144-206`
  with `reasoning_content` → reasoning channel for DeepSeek/Kimi). Covers OpenAI-compatible endpoints via
  `baseUrl` (`:29`).
- `createAnthropicModelClient` (`infra/src/backends/AnthropicModelClient.ts:29`) — Messages API;
  implements **`createTurn` only — NO `streamTurn`** (`:33-61`). Maps text/thinking/tool_use + cache-read
  usage.

**Production wiring** (verified firsthand, `manager/container.ts`):
- `buildLaneTooling` (`:743-754`) projects `orchestratorDefs`/`workerDefs`/`peerDefs`/`workflowWorkerDefs`
  onto a `Map<string,RuntimeTool>` via `toRuntimeTool`, with prefixed MCP names + JSON schemas.
- `anthropicBackend = createInProcessBackend("anthropic-api", spec => ({model: createAnthropicModelClient({apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: spec.model, tools}), tools, gate: makePolicyToolGate(...)}))` (`:758-765`).
- `openaiEnv` (`:768-775`) → `createOpenAIModelClient({apiKey: process.env.OPENAI_API_KEY, baseUrl: process.env.OPENAI_BASE_URL, ...})`; `openaiBackend`/`codexBackend` (`:776-777`).
- Registry `backendMap` (`:867-872`) registers claude-cli/anthropic-api/openai/codex; claude-sdk added
  at `:875`. `backends.{get,has,descriptors}` (`:876-880`).
- `makePolicyToolGate` (`manager/backends/PolicyToolGate.ts:11-19`) — the in-process `ToolGate` over the
  same `PolicyGatewayService` all three lanes share; fail-closed; blocks built-in tools.

### 2.5 Conformance suite — what it actually requires

`infra/src/__tests__/agent-backend-conformance.ts:32-92` asserts 5 universal invariants:
1. `start` returns a session with handle + boolean caps + `isAlive()` true, and fires `onSpawn` (`:39-51`).
2. `sendMessage` resolves to an `{ok:boolean}`-shaped, ok result (`:53-61`).
3. `attach` reconstructs an alive session for the same worker (`:63-70`).
4. `stop` is idempotent and flips `isAlive()` to false (`:72-79`).
5. `onExit` fires when the session ends (optional, gated on `triggerExit`, `:81-90`).

`InProcessBackend(fakeModel)` is wired in and passes all five
(`agent-backend-conformance.test.ts:13-23`, `settle` = `whenSettled`, `triggerExit` = `attach(...).stop()`).

**Assessment: `InProcessBackend` is fully conformant.** It satisfies every invariant the suite checks.
The suite is intentionally minimal — a universal *shape* net, not a lifecycle-depth test. So "conformant"
here means "a structurally valid adapter," **not** "a production-ready API lane." Everything in §3 is gap
*beyond* what conformance measures.

---

## 3. Gaps & missing pieces for the multi-provider API lane

### 3.1 STUBBED / DISABLED / no-op (cited high-value signal)

- **`enabled:false` on all three in-process descriptors** (`InProcessBackend.ts:55-57`). Not offered by
  the UI picker; `spawnBackendError` refuses an explicit pick (`spawn-backend.ts:56-57`). Flipping this
  is the first enablement step.
- **Metered billing opt-in has no UI path.** Even with `enabled:true`, a bare metered pick is rejected
  because the explicit-pick path leaves `costMode` unset for metered (`spawn-backend.ts:26`) and
  `spawnBackendError` requires `costMode:"billed"` (`:59-60`). Today the *only* opt-in is a config
  profile carrying `costMode:"billed"`. No affordance for a UI user to consent to metered billing.
- **`streamingThinking` absent from in-process `CAPS`** (`InProcessBackend.ts:44-51`) although
  `ToolRuntime` emits `delta` events and `OpenAIModelClient` streams. The UI's live-thinking renderer
  gates on `capabilities.streamingThinking` (per the flag's contract, `AgentBackend.ts:38-41`) — so live
  deltas are emitted but won't render. Inconsistency / latent bug.
- **`AnthropicModelClient` has no `streamTurn`** (`AnthropicModelClient.ts:33-61`) — the `anthropic-api`
  lane cannot stream live thinking at all, regardless of the CAPS flag.
- **`clearContext` emits no `session:"cleared"` event** (`InProcessBackend.ts:104-110`). It drops the
  buffer but `processAgentSignal`'s cleared handler (context→0, tasks→null, settle IDLE,
  `ProcessAgentSignal.ts:100-109`) never fires from the backend for an in-process `/clear`. The
  slash-command path may compensate (dim 3 seam — flag below).
- **`setModel` is a hard no-op** (`InProcessBackend.ts:113`, `runtimeModelSwitch:false`). The model is
  fixed by the env factory per session; a runtime model switch persists for next-spawn only. Acceptable
  but a stated limitation.
- **`attach` returns a session even when no live entry exists** (`InProcessBackend.ts:143-145`). After a
  restart the methods 410/return-false and `isAlive()` is false — i.e. attach silently yields a dead
  session rather than signalling absence (see 3.2).

### 3.2 MISSING (what the API lane needs that isn't there)

- **Restart durability / resume — THE biggest gap.** `sessionStore:"none"`, no `session:"ready"`+`sessionId`
  ever emitted (`InProcessBackend.ts:139` emits only `"started"`), conversation lives only in the
  in-memory `live` Map. `reconcileWorkersOnBoot` (`ReconcileWorkersOnBoot.ts:38`) closes any row without a
  `session_id` as DONE; `resumeWorker` (`ResumeWorker.ts:52`) refuses without one. **No code path revives
  an in-process worker after a daemon restart — the conversation is lost.** For a persistent metered
  orchestrator this is fatal.
- **No conversation persistence layer.** Nothing serializes `LiveSession.messages` to disk/DB, and nothing
  rehydrates it. There is no `ConversationStore` port. Required before any in-process resume.
- **Per-profile provider config is dropped before the adapter.** `resolveSpawnBackend` computes
  `ResolvedBackend.baseUrl`/`auth`/`params`/`pricing` (`BackendDefaults.ts:8-16`), but the spawn handler
  threads only `rb.model` (`spawn-worker.ts:122`) and `rb.profileName` (`:123`) onto the spec.
  `SpawnWorkerSpec` has no slot for `baseUrl`/`auth`/`params`; `BackendLaunchOptions` has `auth`/`params`
  but **not `baseUrl`** (`AgentBackend.ts:104-110`), and `SpawnWorker` sets only `backendOptions:{spec}`
  (`SpawnWorker.ts:256`). The in-process factory consequently reads **global** `process.env`
  (`container.ts:761,771`). So "any provider by API key or localhost base URL" cannot be expressed
  per-worker / per-profile today — base URL is one global env var, the API key one global env var, and
  `params` (temperature/max_tokens/reasoning) reach neither factory nor model client.
- **No model catalog for `openai-compatible` providers.** `models:{kind:"openai-compatible"}`
  (`InProcessBackend.ts:56-57`) has no catalog source (claude lanes share the bundled `/v1/models`). The
  UI picker + model validation need a `static`/`openai-compatible` catalog. (Model selection is dim 4;
  the descriptor seam is here.)
- **No `ModelCapabilities` (effort levels) for these providers.** `spawnWorker` normalizes effort via
  `deps.caps.effortLevelsFor(model)` and fails open on unknown models (`SpawnWorker.ts:169-176`) — fine,
  but no real capability data exists for non-Claude models. (dim 4.)
- **No integration test of the in-process lane's full lifecycle.** Only the universal conformance run with
  a fake model exists. No test asserts the canonical event sequence (session started → turn started →
  delta → message → usage → context → turn ended), the billing/`usage` accounting, error/abort
  propagation to the FSM, or the real model clients end-to-end. The model-client *mappers*
  (`parseOpenAIResponse`/`parseAnthropicResponse`) are exported and unit-testable, but the *adapter*
  lifecycle is untested beyond the 5 invariants.
- **Mid-request interrupt is impossible on the non-streaming path.** `AnthropicModelClient.createTurn`
  awaits the whole HTTP response; the abort signal is only checked between round-trips
  (`ToolRuntime.ts:43`) and inside the streamed body (`parseOpenAIStream` `:159`). A long single
  Anthropic request can't be cancelled mid-flight.

---

## 4. Design implications & options (SOLID-aligned, with the ports/types/files they touch)

The seam is sound: descriptor-driven, capability-gated, registry-pluggable. Adding/enabling a provider is
Open/Closed — register a descriptor + adapter, never edit consumers. The work below is hardening, not
re-architecting.

**Option A — Enablement (smallest).** Flip `enabled:true` on the in-process descriptors
(`InProcessBackend.ts:55-57`), add an `openai-compatible`/`static` model catalog source (dim 4 overlap),
and add a UI metered-billing opt-in that sets `costMode:"billed"` on the explicit-pick path
(`spawn-backend.ts:26`). Low structural risk; unblocks selection.

**Option B — Per-profile provider config (the key "any provider" enabler).** Thread
`ResolvedBackend.baseUrl`/`auth`/`params` from the resolver, through the spawn spec, into the
`InProcessEnvFactory`, so each worker's model client uses *its profile's* endpoint/key/params, not global
env. Touches: add `baseUrl` to `BackendLaunchOptions` (`AgentBackend.ts:104-110`); have `spawn-worker.ts`
populate `backendOptions.{auth,baseUrl,params}` from `rb` (currently only `model`+`profileName`,
`:122-123`); have `SpawnWorker.start` forward them (`SpawnWorker.ts:256`); have the `container.ts`
factories (`:758-777`) read `spec.backendOptions.{auth,baseUrl,params}` and resolve the `AuthRef`
(env/keychain) via an auth resolver instead of `process.env.*`; the model clients already accept
`baseUrl`/`maxTokens` (`OpenAIModelClient.ts:17-25`, `AnthropicModelClient.ts:18-27`). DIP-clean: the
adapter stays env-agnostic, the composition root resolves credentials.

**Option C — Durability / resume (closes the biggest gap).** Two sub-options:
- **C1 (resumable metered lane):** introduce a `ConversationStore` port (new, in `core/src/ports/`) + an
  infra adapter that persists `LiveSession.messages` keyed by `workerId`+a generated `sessionId`. Have
  `InProcessBackend.start` emit `{type:"session",phase:"ready",sessionId}` (so `ProcessAgentSignal:94-97`
  persists it and `ReconcileWorkersOnBoot:38` keeps the row SUSPENDED), and rehydrate `messages` from the
  store when `backendOptions.resume` is set. Add a distinct `sessionStore` enum value (e.g. `"eos-jsonl"`)
  to `BackendDescriptor` (`AgentBackend.ts:79`) + `canHandoffBackend` (`backend-switch.ts:24-29`) — note a
  new store value is intentionally NOT loadable by the claude lanes, so cross-lane handoff stays blocked
  (correct). Touches: `InProcessBackend.ts`, new port+adapter, descriptor enum; `ResumeWorker`/reconcile
  already work once a `session_id` exists.
- **C2 (accept ephemerality, documented):** keep `sessionStore:"none"`; metered workers are
  non-resumable and boot closes them. Simpler, but persistent metered orchestrators are unsupported.

Recommendation: C1 if the orchestrator (or any persistent worker) may run on a metered API across a daemon
restart; C2 only if the lane is scoped to ephemeral worker tasks.

**Option D — Streaming parity.** Set `streamingThinking:true` in the in-process descriptor capabilities,
and add `streamTurn` to `AnthropicModelClient` (mirror `parseOpenAIStream`). Because `streamingThinking`
must be true for openai but false for anthropic-api-until-it-streams, the flag should be **per-kind** —
the `IN_PROCESS_DESCRIPTORS` map (`InProcessBackend.ts:54-58`) already supports per-kind capability
objects; the shared `CAPS` const (`:44-51`) currently flattens them.

**Option E — `/clear` correctness.** Emit `{type:"session",phase:"cleared"}` from
`InProcessBackend.clearContext` (`:104-110`) so the FSM/context-ring reset fires, matching the SDK lane.
Small, isolated.

**SOLID notes.** LSP holds for the mandatory `AgentSession` surface (conformance proves it); the optional
methods are correctly ISP-gated by capability, so an incapable lane omits them rather than throwing.
Durability via `start(backendOptions.resume)` reuses the existing contract — no LSP break. The one
Liskov-adjacent smell is `attach` returning a non-alive session after restart (`:143-145`); a cleaner
contract would let `attach` signal absence, but the daemon already routes resume through `start`, so this
is cosmetic.

---

## 5. Open questions / conflicts with sibling dimensions

- **Dim 2 (ToolRuntime / tools):** the in-process tool surface is `buildLaneTooling`
  (`container.ts:743-754`) projecting the def lists onto `RuntimeTool`. I assert the *factory wiring*
  exists; whether the surface is *complete* (write/bash/read/glob/grep/edit/MCP/skills behave correctly
  in-process) is dim 2's call. The `ToolGate` chokepoint (`ToolRuntime.ts:110-131`) is shared.
- **Dim 3 (MCP / skills / commands):** `/clear` is intercepted in `dispatchMessage`
  (`DispatchMessage.ts:250-278`) and calls `session.clearContext`; whether the slash side-effects ALSO
  produce the `conversation_cleared` / `session:"cleared"` signal is dim 3. **Flag:** `InProcessBackend.clearContext`
  emits no `session:"cleared"` event (§3.1) — confirm dim 3 covers the FSM/context-ring reset, else
  Option E is required.
- **Dim 4 (config / model-selection / DPI):** Options A/B overlap their turf — the `openai-compatible`
  model catalog, `ModelCapabilities` for non-Claude models, the `costMode:"billed"` UI opt-in, and
  per-profile `baseUrl`/`auth`/`params` resolution all touch config + model selection. Coordinate on who
  owns threading `ResolvedBackend.{baseUrl,auth,params}` into the spawn spec.
- **Dim 5 (permissions / gateway):** `makePolicyToolGate` (`PolicyToolGate.ts`) routes the in-process lane
  through the same `PolicyGatewayService` as claude-cli/claude-sdk — no conflict; just note all three
  lanes share one decision engine and the internal `ask` verdict blocks as an await with no TTL.
- **Open question:** does flipping `enabled:true` alone make the lane selectable, or is there a UI
  provider-list filter on `descriptor.enabled`? `backends.descriptors()` returns all (`container.ts:879`);
  the filter (if any) lives in the UI/routes — confirm with dim 4.
- **Open question (billing identity):** the `anthropic-api` lane reads `process.env.ANTHROPIC_API_KEY`
  (`container.ts:761`) while `claude-sdk` uses the subscription OAuth token via `authResolver`. Both hit
  Anthropic but differ on billing class (`descriptor.billing` metered vs subscription) — ensure the design
  never lets a metered Anthropic profile silently ride the subscription credential, or vice versa.
