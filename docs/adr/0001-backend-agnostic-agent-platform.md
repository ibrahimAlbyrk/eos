# ADR 0001 — Backend-Agnostic Agent Platform

- **Status:** Proposed
- **Date:** 2026-06-05
- **Supersedes:** —
- **Affects:** `contracts/`, `core/`, `infra/`, `spawner/`, `gateway/`, `manager/`, `manager/web/`

> This ADR is the synthesis of a six-lane architecture study (execution layer, core
> ports, contracts/events, daemon orchestration & MCP, permission/gateway,
> config/cost/persistence). Where it asserts current behavior it cites `file:line`.

---

## 1. Context

Eos is an orchestration layer built **on top of the interactive `claude` CLI binary**.
Every agent — orchestrator or worker — is a `claude` TUI process driven through a PTY
(`node-pty`) by `spawner/worker.ts`, observed by tailing Claude's JSONL transcript and
its hook callbacks, and permission-gated by exploiting Claude Code's `PermissionRequest`
hook as a synchronous gateway.

We want to **decouple the application/orchestration layer from the agent execution
layer** so that any backend can be plugged in:

- the existing Claude-Code-via-PTY backend (**must remain the default, unchanged**),
- the Claude Agent SDK,
- the raw Claude / Anthropic API,
- OpenAI / Codex,
- any other LLM or agent API,

with **per-role backend selection** (a worker and its orchestrator may run on different
backends/models), expressed through clean, SOLID, configurable, extensible structure.

### 1.1 Hard constraints

1. **`claude-cli` stays the default and keeps working byte-for-byte.** It runs as an
   *interactive PTY* session so the user's Max/Pro subscription pays for tokens.
   **Never `claude -p`, never the SDK for this backend** — those draw from a separate
   paid pool. This subscription constraint is *backend-specific*: it applies only to
   `claude-cli`.
2. **Billing follows the backend.** The Max/Pro subscription is PTY-only. *Every* other
   backend — including the Claude API or SDK — bills from a separate pool (API key /
   Agent-SDK credits / OpenAI). Multi-backend therefore means **"bring your own API key
   for any non-`claude-cli` agent."** This must be explicit in defaults and surfaced in
   the UI, or users incur surprise charges.
3. **Clean Architecture dependency direction is lint-enforced:**
   `contracts/ → core/ → infra/ → entrypoints`. `core/` has zero Node imports and uses
   the `Clock` port, never `Date.now()`.
4. **Cost is display-only.** Per-worker budget enforcement was deliberately removed; do
   not reintroduce caps.

### 1.2 Decisions recorded for this ADR

| # | Decision | Choice |
|---|----------|--------|
| D1 | ToolRuntime scope for Eos-driven backends | **Full Claude-Code parity** (target end-state), delivered in capability tiers (§6.3, §9) |
| D2 | First non-`claude-cli` backend | **Anthropic API** — it forces the reusable ToolRuntime every other Eos-driven backend then shares |
| D3 | Cost display for the subscription-paid `claude-cli` backend | **"included" + notional** — show "included" as the headline, still compute the notional API-equivalent for information |
| D4 | Next step | This document (ADR) before any code |

---

## 2. Key finding: the coupling is concentrated, not pervasive

The codebase is far better positioned for this change than "rigid/badly written" implies.
The clean-architecture seams are mostly already in the right place:

- `core/src/use-cases/SpawnWorker.ts` already takes `buildArgs`/`buildEnv`/`supervisor`
  as **injected dependencies** — it never imports `child_process` and does not know what
  the argv means (`SpawnWorker.ts:47,81,85`).
- `core/src/services/PolicyGatewayService.ts` is **pure decision logic** — its
  `evaluate()` 3-step chain has zero Claude / PTY / hook / HTTP imports
  (`PolicyGatewayService.ts:110-129`).
- `core/src/domain/mcp-resolution.ts` is a **pure resolver**; the inheritance machinery
  (`SqlBackedModeResolver.ts:27-40`) is a reusable parent-climb.

All Claude-specificity lives in **three places**:

1. **`spawner/`** — the PTY child: `node-pty` spawn of `claude` (`worker.ts:90`), the
   `╭` composer-ready glyph (`readiness-gate.ts`), JSONL tail (`tail.ts`), hook ingest
   (`worker.ts:242-304`), the 300 ms CR delay (`pty-queue.ts`), and Claude CLI argv
   (`claude-args.ts`).
2. **The event contract** (`contracts/src/events.ts`) — `hook`/`jsonl`/`usage` events are
   written in Claude's vocabulary: hook names (`events.ts:9-15`), JSONL kinds
   (`events.ts:28-34`), cache tiers (`events.ts:63-75`), `session_id`.
3. **The permission transport** — `scripts/hooks/auto-allow.sh` exploits Claude Code's
   `PermissionRequest` hook; the policy *engine* underneath is already backend-agnostic.

Everything else (`SpawnWorker`, `PolicyGatewayService`, `mcp-resolution`, the inheritance
resolver, the event repo/SSE/CLI) is structurally backend-neutral and is *reused*, not
rewritten.

---

## 3. The central reframe: two backend families

The single most important abstraction is not "which LLM" but **who runs the agentic
loop**. This one distinction determines tool-calling, permissions, observability, and
process model simultaneously.

| | **Self-driving backends** | **Eos-driven backends** |
|---|---|---|
| Examples | `claude-cli` (PTY), `claude-sdk` | `anthropic-api`, `openai`, `codex`-as-API |
| Runs the loop (LLM ↔ tool ↔ repeat) | The backend | **Eos** (`ToolRuntime`, §6.3) |
| Executes tools (Read/Edit/Bash) | The backend | **Eos** |
| Provides tools | MCP server (CLI) / SDK tools | Eos in-process `ToolRegistry` |
| Mediates permissions | Hook (CLI) / `canUseTool` (SDK) | Eos gates **inline** in the loop |
| Eos observes via | Tail JSONL + hooks → translate | Eos emits canonical events from its own loop |
| Process model | out-of-process (PTY) / either (SDK) | in-process (default) or child for isolation |

A second, **orthogonal axis** is the *process boundary* (in-process vs out-of-process).
It is a property of each backend adapter, not a global: `claude-cli` *must* be
out-of-process (`node-pty` needs Node, not Bun; crash containment; the `pgrep eos-*`
orphan-reaper); an API backend defaults to in-process but can be hosted in a child for
isolation.

A backend integrates with Eos through exactly **two surfaces** plus **capability
injection at launch**:

- **Surface 1 — Control:** `AgentBackend` / `AgentSession` (§6.1).
- **Surface 2 — Observation:** the canonical `AgentEvent` stream (§6.2).
- **Capability injection:** tools (`ToolRegistry`, §6.3), system prompt, permission mode
  — pushed in at `start()`.

---

## 4. Target architecture

```
              ┌──────────────────── APPLICATION LAYER (backend-agnostic) ───────────────────────┐
              │                                                                                  │
 web/cli/app  │  daemon routes ─► core use-cases (SpawnWorker, KillWorker, DispatchMessage, …)   │
   ◄───SSE────┤        │                  │                                                      │
              │        │      PolicyGatewayService (pure engine)   ToolRegistry (orchestration   │
              │        │      PendingQuestionService (human-prompt)   tools defined ONCE)        │
              │        ▼                  │                                                      │
              │  ProcessAgentSignal ◄─────┼──── canonical AgentEvent stream ◄────────┐           │
              │  (state machine on        │                                          │ surface 2 │
              │   canonical signals)      ▼                                          │ OBSERVE   │
              │                  ┌──────────── AgentBackend (port) ──────────────────┐│           │
              └──────────────────┤ start(spec, emit) → AgentSession                  ├┘           │
                  surface 1       │ sendMessage / interrupt / answer / stop (CONTROL)│            │
                  CONTROL         └──┬──────────────┬───────────────┬───────────────┘            │
                                     │              │               │
                       ┌─────────────▼──┐  ┌────────▼─────────┐  ┌──▼──────────────────────┐
                       │ ClaudeCliBackend│  │ ClaudeSdkBackend │  │ ApiBackend / CodexBackend│
                       │ out-of-process  │  │ in-process       │  │ in-process ToolRuntime   │
                       │ PTY, JSONL tail,│  │ SDK query,       │  │ hosts the loop, exec     │
                       │ hooks,          │  │ canUseTool,      │  │ tools, inline policy     │
                       │ ProcessSupervisor│ │ SDK tools        │  │ gate, MCP *client*       │
                       │ ⇒ canonical     │  │ ⇒ canonical      │  │ ⇒ canonical (native)     │
                       └─────────────────┘  └──────────────────┘  └──────────────────────────┘
```

**Layer ownership:**

- **Application layer** (backend-agnostic): `contracts/` canonical model, `core/`
  use-cases + state machine + policy engine + resolvers, `manager/` daemon/routes/DI,
  `ToolRegistry`, and the `ToolRuntime` (the Eos-hosted agent loop).
- **Agent layer** (backend-specific): the `AgentBackend` adapters. Each owns its native
  transport and is the *only* place that knows hooks/JSONL/SSE/SDK details. Each
  translates to canonical events.

---

## 5. Components that are reused as-is (no rewrite)

These are backend-agnostic today and are *consumed*, not rebuilt:

- `core/src/services/PolicyGatewayService.ts` — the policy engine (only the *transport*
  in front of it is Claude-specific; §6.4).
- `core/src/domain/permission-mode.ts` `MODE_SPECS` — operates on the *category*, not the
  tool name; unchanged. (`classifyTool` becomes pluggable — §6.4.)
- `core/src/services/SqlBackedModeResolver.ts` — generalized into a shared
  `InheritedAttributeResolver<T>` reused for mode **and** backend (§6.5).
- `core/src/use-cases/TransitionState.ts` — already clean.
- `core/src/domain/mcp-resolution.ts` — pure; output type widened to a backend-neutral
  capability list (§6.3).
- `manager/services/PendingQuestionService.ts` — the human-prompt blocking machinery,
  reusable for Eos-driven backends (and currently bypassed — §11).
- The SQLite event repo, SSE broadcaster, and CLI data layer — structurally agnostic
  (they carry opaque rows).

---

## 6. Detailed design

### 6.1 Surface 1 — Control: `AgentBackend` + `AgentSession`

New ports in `core/src/ports/` (no Node imports). They replace `ProcessSupervisor` *as
the seam*; `ProcessSupervisor` survives, demoted to a private dependency of
out-of-process backends.

```ts
type BackendKind = "claude-cli" | "claude-sdk" | "anthropic-api" | "openai" | "codex" | string;

interface AgentLaunchSpec {
  workerId: string;
  profile: ResolvedBackend;                          // §6.5 — kind + model + params + authRef
  role: "orchestrator" | "worker";
  prompt?: string;
  cwd: string | null;
  systemPrompt: { base: string; append: string };    // base="" for claude-cli (CLI supplies it)
  permissionMode: PermissionMode;
  parentId: string | null;
  tools: ToolDefinition[];                            // §6.3 — registry projection for this agent
  // Deliberately NO args / env / port — those are claude-cli adapter internals.
}

interface AgentBackend {                              // factory, one per kind, chosen by BackendFactory
  readonly kind: BackendKind;
  readonly processModel: "in-process" | "out-of-process";
  start(spec: AgentLaunchSpec, emit: (e: AgentEvent) => void): Promise<AgentSession>;
}

interface AgentCapabilities {
  interrupt: boolean;
  rawInput: boolean;                                  // keystroke injection (PTY only)
  runtimeModelSwitch: boolean;
  runtimePermissionSwitch: boolean;
}

interface AgentSession {                              // the live unit of execution
  readonly id: string;
  readonly capabilities: AgentCapabilities;
  sendMessage(text: string): Promise<void>;          // accepts a turn; completion observed via events
  interrupt(): Promise<void>;
  respondToPermission(d: PermissionDecision): Promise<void>;   // no-op for hook-mediated claude-cli
  answerQuestion(answers: Record<string, string>): Promise<void>;
  sendRaw?(bytes: string): Promise<void>;            // optional: PTY keystrokes; absent on API/SDK
  setModel?(model: string): Promise<boolean>;
  setPermissionMode?(mode: PermissionMode): Promise<boolean>;
  stop(graceMs?: number): Promise<void>;             // graceful → forced; idempotent
  isAlive(): boolean;
}

interface AgentBackendRegistry { get(kind: BackendKind): AgentBackend; has(kind: BackendKind): boolean; }
```

**Principles:**

- **ISP via optional + capability flags**, never LSP-violating `throw "unsupported"`
  stubs. A bare-API backend omits `sendRaw` and advertises `rawInput:false`; callers
  feature-detect on `capabilities`.
- **`AgentLaunchSpec` carries no `args`/`env`/`port`.** Today those leak through
  `SpawnWorker.buildArgs/buildEnv` + `manager/shared/worker-args.ts`; they sink into the
  `claude-cli` adapter. This is the single biggest leak to fix.
- **`port`-keyed addressing becomes an opaque `WorkerHandle`**
  (`{kind:"http",port}` | `{kind:"inproc",ref}`). `DispatchMessage` must stop treating
  "no port" as "broken" (`DispatchMessage.ts:48`) and gate on `session.isAlive()`.

**`ClaudeCliBackend` absorbs all PTY coupling.** Behind this one adapter live:
`ProcessSupervisor`, `PortAllocator`, the `WorkerClient` HTTP transport, `buildClaudeArgs`,
the synthesized `mcp.json`, the `╭` readiness gate, the JSONL tail, the hook ingest, the
prompt-ack watchdog, the `eos-<name>-` orphan-reaper, and the `129/143` exit-code mapping.
`stop()` performs today's SIGTERM→SIGKILL escalation.

### 6.2 Surface 2 — Observation: the canonical event model

New `contracts/src/canonical.ts`. Every adapter emits these; the daemon, core state
machine, SQLite log, SSE, and rewritten web parser become **canonical-only by
construction**.

```ts
// content blocks — the universal primitives
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; redacted?: boolean }   // was "thinking"; ABSENT for Codex — never synthesize empty
  | { type: "tool_call"; callId: string; name: string; input: unknown; parentCallId?: string | null }
  | { type: "tool_result"; callId: string; isError: boolean; content: string };

type AgentEvent =
  | { type: "message"; role: "assistant" | "user" | "tool"; blocks: ContentBlock[]; model?: string }
  | { type: "turn"; phase: "started" | "ended" | "aborted" | "error"; reason?: string }   // replaces hook Stop/SessionEnd + lifecycle
  | { type: "activity"; kind: "tool_started" | "tool_finished" | "alive" }                // replaces tool_running/tool_done/heartbeat
  | { type: "usage"; inputTokens: number; outputTokens: number;
        cacheReadTokens?: number; cacheWriteTokens?: Record<string, number>; model?: string }  // §6.6
  | { type: "permission_request"; callId: string | null; toolName: string; input: unknown }
  | { type: "question_request"; callId: string | null; questions: unknown[] };

// every event rides an envelope:
interface AgentEventEnvelope { backend: BackendKind; workerId: string; turnId: string | null; seq?: number; ts: number; }
```

**Resolved design choices:**

- **Translation happens in the backend adapter, always**, regardless of where the adapter
  physically runs. The `claude-cli` adapter (inside the PTY child) translates hooks+JSONL
  → canonical there; `ApiBackend` emits canonical natively. The daemon never sees a
  `hook`/`jsonl` event again.
- **Keep raw Claude `hook`/`jsonl` as an optional debug sidecar** so PTY fidelity
  (subagent attribution, dual-channel dedup) is preserved for replay/debug but is no
  longer the primary contract.
- **`turnId` replaces `session_id`** as the abstract turn key; `session_id` stays a
  `claude-cli`-private detail (it still locates the JSONL file at `tail.ts:30` and
  subagent meta at `subagent-meta.ts:21`).
- **The state machine consumes canonical signals.** `ProcessWorkerEvent.ts` (today a
  switch over `hook`/`jsonl`/`heartbeat`, `ProcessWorkerEvent.ts:45-164`) becomes a
  signal→state reducer:

  | Canonical signal | Transition (guarded) | Replaces |
  |---|---|---|
  | `turn{started}` / `activity{tool_started}` / `activity{alive}` | → WORKING | hook:PostToolUse, jsonl:tool_use, heartbeat |
  | `turn{ended}` | → IDLE, `markSettling()` | hook:Stop |
  | `turn{error}` / lost | → IDLE(reason) | lifecycle:prompt_unacknowledged |
  | `session{ended}` | → DONE | onExit(code) |

  The **settle-window** (`isSettling`/`markSettling`, `ProcessWorkerEvent.ts:60-67`) is
  backend-agnostic and stays. The ordered `turn{started/ended}` + `seq` is the eventual
  path to **deleting `TurnSettleService`** (it exists only because hooks and JSONL race on
  unordered channels) — but only once the adapter guarantees ordered turn boundaries; not
  automatic.

### 6.3 Capability injection — `ToolRegistry` and `ToolRuntime`

#### `ToolRegistry` — define a tool once, project three ways

Orchestration tools (`spawn_worker`, `message_worker`, `list_active_workers`, `get_worker`,
`kill_worker`, `list_pending_permissions`, `send_message_to_parent`) are today MCP modules
that HTTP-shim to daemon routes. Define each **once**:

```ts
interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;                  // already Zod today (spawn_worker.ts:13)
  visibility: "orchestrator" | "worker" | "all";
  capability: ToolCategory;                 // §6.4 — tag, do not name-match
  execute(input: I, ctx: ToolContext): Promise<O>;   // ctx.facade = OrchestrationFacade
}
interface ToolRegistry { list(v: "orchestrator" | "worker"): ToolDefinition[]; get(name: string): ToolDefinition | undefined; }
```

Three projections of the same registry:

1. **MCP subprocess (`claude-cli`, behavior unchanged):** `orchestrator-mcp.ts` becomes a
   generic loop registering `registry.list(...)`; each `execute` calls an **HTTP-backed**
   `OrchestrationFacade` (today's shim) because it runs in a separate process.
2. **In-process (`anthropic-api`/`codex`):** the `ToolRuntime` maps the registry to the
   provider's tool-spec JSON and calls `execute` against an **in-process**
   `OrchestrationFacade` (direct core use-case calls, no HTTP).
3. **SDK tools (`claude-sdk`):** `createSdkMcpServer({ tools: registry.map(tool(...)) })`
   — same registry, SDK runs the loop.

`spawn_worker` therefore becomes **one core use-case with two projections** (HTTP for CLI,
in-process for the rest), both terminating in the same `spawnWorker`. Report-back becomes a
`DeliverReport` use-case behind a `WorkerClient` whose impls differ (PTY-stdin injection vs
append-message-and-re-enter-loop).

```ts
interface OrchestrationFacade {            // narrow facade onto use-cases; HTTP impl (CLI) + in-proc impl (API/SDK)
  spawnWorker(spec): Promise<{ id; handle; name? }>;
  messageWorker(id, text, fromParent): Promise<void>;
  listWorkers(): Promise<WorkerSummary[]>;
  getWorker(id): Promise<{ worker; events }>;
  killWorker(id): Promise<KillResult>;
  listPending(): Promise<PendingSummary[]>;
  report(fromWorker, text): Promise<void>;
}
```

#### `ToolRuntime` — the Eos-hosted agent loop (D1: full parity)

For Eos-driven backends, **Eos hosts the loop**: call model → receive `tool_use` → execute
tool (gated) → feed `tool_result` → repeat until end-turn. Per **D1**, the target is **full
Claude-Code parity**, which means Eos must own:

- the full built-in tool suite (Read, Write, Edit/MultiEdit, Bash + shell session
  management, Glob, Grep, LS, WebFetch/WebSearch, NotebookEdit, …),
- an **MCP *client*** (mirror of today's server) to connect to inherited user MCP servers,
- a **Task / subagent** equivalent,
- conversation/turn/context-window management, streaming, and prompt-caching.

```ts
async function runTurn(conv: Conversation, tools: ToolDefinition[], backend: ModelClient, ctx) {
  for (;;) {
    const resp = await backend.createMessage({ system: ctx.systemPrompt, messages: conv.messages,
                                               tools: toToolSpecs(tools), signal: ctx.abort });
    emitCanonical(resp);                                  // surface 2: emit message/usage natively
    const calls = resp.toolCalls;
    if (calls.length === 0) { emit({ type: "turn", phase: "ended" }); return; }
    for (const c of calls) {
      const decision = await ctx.policy.decide({ backendId, sessionId, toolName: c.name, input: c.input });  // §6.4 inline gate
      const result = decision.behavior === "allow"
        ? await executeTool(c, ctx)                       // single chokepoint — gating cannot be skipped
        : denyResult(c, decision.message);
      conv.append(toolResult(c.callId, result));
      emit({ type: "message", role: "tool", blocks: [toolResultBlock(c.callId, result)] });
    }
  }
}
```

> **D1 cost/risk acknowledged.** Full parity is "re-implement Claude Code's runtime" — the
> largest, most behavior-sensitive, most divergence-prone part of this effort. We accept it
> as the *end-state* but **deliver it in capability tiers** (§9, Phase 4) so each tier ships
> and is independently useful. Tier order: orchestration tools → file/shell suite → MCP
> client + subagents → exotic tools. The reusable loop is built once against the Anthropic
> API (**D2**) and shared by every later Eos-driven backend.

### 6.4 Permissions — engine reuse, transport per backend

`PolicyGatewayService.decide()` is already the canonical decision authority. The redesign
introduces a **transport-selection seam** in front of it; the engine is untouched.

| Backend | Interception point | How `decide()` is reached |
|---|---|---|
| `claude-cli` (today) | `PermissionRequest` hook (`auto-allow.sh`) | out-of-process curl → `/policy/decide` — **unchanged** |
| `claude-cli` (fallback) | `--permission-prompt-tool mcp__gateway__decide` | gateway MCP → `DaemonProxyPolicy` → HTTP — **unchanged** |
| `claude-sdk` | `canUseTool(name, input)` callback | in-process call; map `Decision` → SDK allow/deny |
| `anthropic-api` / `codex` | `ToolRuntime` before each tool exec | in-process call; on deny, return a `tool_result` with the deny message |

- **`ask`/pending/web-banner machinery is 100% reused.** For in-process backends a pending
  decision is simply an `await`; an interrupt's `AbortController` must also reject parked
  `decide()`/`ask()` promises (mirroring `PolicyGatewayService.ts:56-62`).
- **`classifyTool` becomes capability-tagging.** `{Edit,Bash,Read,WebFetch}` are Claude
  tool names (`permission-mode.ts:27-39`); Codex names tools `apply_patch`/`run_shell`.
  Introduce `ToolCapabilityResolver` (per backend); `claude-cli` keeps today's name table;
  Eos's own tools declare their `capability`. `MODE_SPECS` stays unchanged.
- **Fail-closed by construction.** Funnel all tool execution through one `executeTool()`
  chokepoint that gates internally, so "forgetting to gate" is unrepresentable. (Note: the
  CLI hook currently fails **open** on missing env, `auto-allow.sh:64-65` — a real gap;
  the in-process loops must fail **closed**.)
- **AskUserQuestion / interrupt generalize:** for Eos-driven loops, "ask the human" is a
  tool that `await`s `PendingQuestionService.register()`; "interrupt" is the
  `AbortController`. The daemon-side routes and state transitions are reused as-is.

### 6.5 Configuration, identity, persistence, inheritance

Mirror the existing per-role MCP config precedent (`config.mcp.{orchestrator,worker}` +
pure resolver + port, `config.ts:54-65`, `mcp-resolution.ts:60-69`). Add two config
sections.

```ts
// contracts/src/backend.ts (new)
const BackendKindSchema = z.enum(["claude-cli","claude-api","claude-sdk","openai","codex"]);
const AuthRefSchema = z.object({ kind: z.enum(["subscription","env","keychain"]), ref: z.string().optional() }).strict();
const BackendProfileSchema = z.object({
  kind: BackendKindSchema,
  model: z.string(),
  baseUrl: z.string().url().optional(),
  auth: AuthRefSchema.optional(),                 // omitted ⇒ subscription (claude-cli)
  pricing: z.string().optional(),                 // price-table key; defaults to `${kind}:${model}`
  costMode: z.enum(["billed","included"]).optional(),  // claude-cli ⇒ "included" (D3); API kinds ⇒ "billed"
  params: UnknownRecordSchema.optional(),         // effort, temperature, reasoning, …
}).strict();
```

```jsonc
// config.json — absent config = byte-identical to today
{
  "backends": {
    "claude-cli-opus":   { "kind": "claude-cli", "model": "opus",   "costMode": "included" },
    "claude-cli-sonnet": { "kind": "claude-cli", "model": "sonnet", "costMode": "included" },
    "sonnet-api":        { "kind": "claude-api", "model": "claude-sonnet-4-6",
                           "auth": { "kind": "env", "ref": "ANTHROPIC_API_KEY" }, "costMode": "billed" }
  },
  "defaults": { "orchestrator": { "backend": "claude-cli-opus" },
                "worker":       { "backend": "claude-cli-opus" } }
}
```

- **`mergeConfig` gotcha:** it iterates *base* keys only (`config.ts:199`); `.passthrough()`
  does **not** save you. New sections **must** be declared in `defaults()` or they are
  silently dropped. `backends` merge = per-profile replace (a profile is atomic — `kind`
  drives everything); `defaults` merge = per-role field merge.
- **Persistence (append-only migrations, `MigrationRunner.ts`):**
  ```
  020_workers_add_backend_kind     ALTER TABLE workers ADD COLUMN backend_kind TEXT
  021_workers_add_backend_profile  ALTER TABLE workers ADD COLUMN backend_profile TEXT
  022_backfill_backend_kind        UPDATE workers SET backend_kind='claude-cli' WHERE backend_kind IS NULL
  ```
  Reuse existing `model`/`effort` columns. A null `backend_kind` resolves to `claude-cli`,
  so existing DBs keep working. `WorkerRowSchema` gains `backend_kind`/`backend_profile`
  (nullable+optional); `SqliteWorkerRepo` gains `updateBackend(id, kind, profile)`.
- **Inheritance:** generalize `SqlBackedModeResolver`'s parent-climb into a shared
  `InheritedAttributeResolver<T>`, instantiated for permission-mode **and** backend.
  Resolution order: **explicit-on-row → inherited-from-ancestor → role-default →
  global-default (`claude-cli` + `model ?? "opus"`)**. A child inherits the orchestrator's
  backend unless its own row overrides — satisfying *"worker on X, orchestrator on Y."*
  `spawn_worker` gains an optional `backend` parameter.
- **Secrets:** config stores an **`AuthRef`** (`{kind,ref}`), **never a raw key**. A
  `SecretResolver` infra adapter (env var / macOS Keychain via `security`) materializes the
  key lazily at launch into the backend's env (never argv → never in `ps` or event logs),
  never into SQLite, never logged. `claude-cli` = `subscription` (no secret). Use
  `safeStringify` and omit `auth` from all logged payloads.
- **Env-isolation footgun (critical, constraint #1/#2).** Today the PTY child and the MCP
  servers inherit the daemon's environment wholesale (`worker.ts:95` spreads
  `...process.env`). A stray `ANTHROPIC_API_KEY` in the daemon's env would silently flip the
  `claude-cli` backend **off the Max/Pro subscription onto API billing**. Each backend
  adapter must build its child/client env from an **explicit allowlist**, never by spreading
  `process.env`; `claude-cli` in particular must never inherit a provider API key. Add a CI
  check for key leakage into the PTY child's env.

### 6.6 Cost across heterogeneous backends (D3)

- Re-key the price table from bare alias (`"opus"`) to **`provider:model`**
  (`"claude-cli:opus"`, `"claude-api:claude-sonnet-4-6"`, `"openai:gpt-5"`). For
  back-compat, register bare aliases as `claude-cli:<alias>` so existing `config.json`
  `prices` overrides keep working.
- Make cache fields **optional** (`cacheWriteTokens` as an open `Record<tier,number>` so
  new tiers need no schema change); OpenAI/Codex fill only `input`/`output`. Preserve the
  per-field merge; the NaN-on-partial-override hazard disappears because missing tiers are
  absent, not undefined.
- **D3 — subscription treatment:** `claude-cli` profiles are `costMode:"included"`. The
  usage handler still computes the **notional** API-equivalent cost (useful "you'd have
  paid $X" signal) but the headline reads **"included."** API/Codex workers compute real
  cost. The UI must label the source so a mixed-backend aggregate is not misread. Cost
  stays display-only.

---

## 7. Component change map

| Package / file | Change | Risk |
|---|---|---|
| `contracts/src/canonical.ts` (new) | Canonical `AgentEvent` + content blocks | — |
| `contracts/src/backend.ts` (new) | `BackendProfile`, `BackendKind`, `AuthRef` | — |
| `contracts/src/events.ts` | `hook`/`jsonl`/`usage` demoted to optional raw sidecar | Med (consumers) |
| `contracts/src/worker.ts`, `http.ts` | `backend_kind`/`backend_profile`; optional `backend` on spawn | Low |
| `core/src/ports/AgentBackend.ts` (new) | The control seam | — |
| `core/src/ports/{Tool,OrchestrationFacade,BackendDefaults,SecretResolver,ToolCapabilityResolver}.ts` (new) | Supporting ports | — |
| `core/src/use-cases/SpawnWorker.ts` | Depend on `AgentBackend`; drop `buildArgs`/`buildEnv`/`PortAllocator`/`supervisor` | **Med — core surgery** |
| `core/src/use-cases/KillWorker.ts` | Delegate termination to `session.stop()`; keep subtree/cleanup; PID/pgrep → adapter | **Med — most affected** |
| `core/src/use-cases/DispatchMessage.ts` | `session.sendMessage`/`isAlive`; opaque `WorkerHandle` | Low |
| `core/src/use-cases/ProcessWorkerEvent.ts` | Replace with `ProcessAgentSignal` reducer over canonical signals | Med |
| `core/src/use-cases/{SetWorkerModel,SetWorkerPermissionMode}.ts` | Runtime apply via `session.control?`; persist-first stays | Low |
| `core/src/services/InheritedAttributeResolver.ts` (new) + `SqlBacked*Resolver` | Generalize parent-climb; add `BackendResolver` | Low |
| `core/src/domain/{value-objects,permission-mode}.ts` | `provider:model` pricing; `ToolCapabilityResolver` | Low |
| `infra/src/persistence/{MigrationRunner,SqliteWorkerRepo}.ts` | Migrations 020-022; `updateBackend` | Low |
| `infra/src/secrets/DarwinSecretResolver.ts` (new) | env / Keychain | Low |
| `infra/src/backends/` (new) | `ClaudeCliBackend`, `AnthropicApiBackend`, `ClaudeSdkBackend`, `CodexBackend` | **High (new build)** |
| `spawner/*` | Becomes `ClaudeCliBackend`'s child internals; `claude-args`/`tail`/`pty-queue`/`readiness-gate`/`settings`/`subagent-meta` → backend-local; `prompt-ack` + git-worktree half of `worktree.ts` promoted to shared | Med (move/refactor) |
| `manager/container.ts` | `BackendFactory` + registry; `buildArgs`/mcp-synthesis move into `ClaudeCliBackend` | Med |
| `manager/orchestrator-mcp/*`, `worker-mcp/*` | Generic registration loop over `ToolRegistry`; tools defined once | Low |
| `manager/shared/config.ts` | `backends` + `defaults` sections + merge cases | Low (mind §6.5 gotcha) |
| `manager/web/src/lib/messageParser.js` + renderers | Consume canonical `AgentEvent` instead of `jsonl`/`tool_running` | Med (the biggest UI dep) |
| `gateway/*`, `scripts/hooks/auto-allow.sh` | Unchanged — become two transports of N for `claude-cli` | — |

---

## 8. The two ACLs that must be rewritten

Only two places have deep structural knowledge of the Claude event vocabulary; everything
else is structurally agnostic. Both are already hand-written anti-corruption layers:

1. **`core/src/use-cases/ProcessWorkerEvent.ts`** — the state machine. → consumes canonical
   signals (§6.2).
2. **`manager/web/src/lib/messageParser.js` `buildBlocks`** — the UI parser. → consumes
   canonical `message.blocks`.

Rewriting these two, plus emitting canonical from the `claude-cli` adapter, is the whole of
Phase 0.

---

## 9. Migration roadmap

**Strategic point:** Phases 0–3 are pure refactors that improve the codebase and are
independently valuable even if no second backend ever ships. The expensive, risky new build
is isolated in Phase 4+. `claude-cli` behavior is preserved throughout.

| Phase | Scope | Ships | Risk |
|---|---|---|---|
| **0. Canonical events** | Add `AgentEvent`; `claude-cli` worker emits canonical (+ raw sidecar); rewrite the two ACLs (§8). | Cleaner event model; no behavior change | Low–Med |
| **1. `AgentBackend` seam** | Wrap PTY path as `ClaudeCliBackend`; collapse `buildArgs`/`buildEnv`/`PortAllocator`/`WorkerClient`/`pgrep`/`ProcessSupervisor`-usage into it; `SpawnWorker`/`KillWorker`/`DispatchMessage` depend on the port; opaque `WorkerHandle`. | Backend seam; behavior-preserving | **Med (core surgery)** |
| **2. Backend config & identity** | `BackendProfile` registry + `defaults` + migrations 020-022 + `BackendResolver` + `SecretResolver`; all default to `claude-cli`. | Per-role backend selection wired (still only `claude-cli` exists) | Low |
| **3. `ToolRegistry`** | Extract orchestration tools to single definitions; project to MCP (CLI unchanged) via generic loop; add `ToolCapabilityResolver`. | One tool definition, three projections | Low |
| **4. Anthropic API backend + ToolRuntime (D1, D2)** — delivered in tiers: | | |
| 4a | ToolRuntime loop + orchestration tools + inline policy gate + canonical emit. | First Eos-driven backend orchestrates | **High** |
| 4b | Full file/shell tool suite (Read/Write/Edit/Bash/Glob/Grep/LS/Web…). | API backend can do real coding | High |
| 4c | MCP *client* + Task/subagents → **full parity**. | API backend at CLI parity | High |
| **5. SDK + Codex** | `ClaudeSdkBackend` (reuse SDK loop + `canUseTool`); `CodexBackend` (reuse ToolRuntime). | Cross-vendor | Med |

**Cross-cutting deliverables & sequencing notes:**

- **Ship a `FakeAgentRuntime` test double as the first artifact of Phase 1** — it lets every
  use-case, the state machine, and the daemon be tested without a real backend, and it is
  the contract conformance harness every later adapter is checked against.
- **Make the Anthropic API a *worker-only* backend first.** A raw-API *orchestrator* needs
  the daemon to host its loop and is materially harder; keep the orchestrator on `claude-cli`
  until the ToolRuntime is proven on workers, then lift the orchestrator.
- **Golden-file checkpoint at the end of Phase 1:** capture the exact `claude-cli` argv/env
  and event stream before and after the seam refactor; they must be byte-identical
  (the refactor is reversible if they diverge).

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **ToolRuntime full parity = "rebuild Claude Code"** (D1) | Tiered delivery (§9 Phase 4); build the loop once on the API (D2) and share it; each tier ships independently. |
| In-process API backend shares the daemon's crash blast-radius | `processModel` flag keeps "host the loop in a child" a deployment toggle, not a rewrite; disciplined error boundaries around the loop. |
| Core surgery on `SpawnWorker`/`KillWorker` under lint-enforced direction | Phase 1 is behavior-preserving; cover with the existing `*.lifecycle`/`*.branch`/`KillWorker.worktree` tests before/after. |
| Permission bypass in an in-process loop | Single `executeTool()` chokepoint; raw executor private; default-deny on unknown tool/category; fail-closed on thrown/timeout decide. |
| SDK `canUseTool` ordering | Empirically verify it fires before *every* tool exec (incl. built-ins) for the pinned SDK version; if not, fall back to an MCP permission-tool shim. |
| Mixed-billing confusion | Defaults are `claude-cli` everywhere; UI labels backend + `costMode`; surprise-charge guardrail in the spawn UI. |
| Canonical migration breaking historical SQLite rows | Canonical-alongside-legacy, never a flag day; the discriminated `type` field is the version discriminator; `backend` tag gives per-row provenance. |
| Subagent attribution degrades for non-Claude backends | `parentCallId` null elsewhere → flat tool lists; accepted UX tradeoff (§11). |
| **Env bleed flips `claude-cli` off the subscription** (stray `ANTHROPIC_API_KEY`) | Per-adapter env allowlist (§6.5); never spread `process.env` into the PTY child; CI key-leak check. |
| In-process workers show phantom-WORKING after a daemon restart | In-process sessions don't survive a restart, but their SQLite row does. Add a daemon-boot state reconcile (none exists today in `container.ts`) that marks orphaned in-process workers terminated. |

---

## 11. Notable findings (verified this study)

1. **`CLAUDE.md` is stale on AskUserQuestion.** It documents a blocking long-poll on
   `/workers/:id/question` via `PendingQuestionService`; the **live** path is
   fire-and-forget `/question-notify` + keystroke answering (`auto-allow.sh:16-25`).
   `ingest.ts` has **no route that calls `onQuestionHook`** — `worker.ts:215` is dead, and
   the `/question`+`PendingQuestionService` blocking path is vestigial. Convenient: it's
   exactly the reusable piece Eos-driven backends need (resurrect it as the canonical
   in-process human-prompt path). Fix the doc.
2. **The permission hook fails *open*** (`auto-allow.sh:64-65` returns `allow` on missing
   env / curl failure) while the MCP gateway fails *closed* (`DaemonProxyPolicy`). Two
   transports for one backend with opposite postures — decide deliberately; in-process
   loops must fail closed.
3. **"Blocked / awaiting-input" is not a real state** — a worker waiting on a question
   reads as WORKING/IDLE. The canonical signal model is ready to promote it to a
   first-class `WorkerState` if desired (touches FSM + contracts + UI). Deferred.
4. **`mcp__*` and `read` are unconditionally allowed in every mode**
   (`permission-mode.ts:33,49`). Safe under Claude (MCP = orchestration plumbing);
   questionable once arbitrary backends mount arbitrary tools — gate by capability (§6.4).

---

## 12. Open questions / future work

- Promote `BLOCKED`/`AWAITING_INPUT` to a first-class `WorkerState`?
- Delete `TurnSettleService` once canonical ordered turn boundaries are guaranteed?
- Richer capability *sets* (`{fs:write, net:egress}`) vs the single `ToolCategory` enum?
- Reconcile the fail-open hook vs fail-closed posture (§11.2).
- Context-window / prompt-cache strategy for the ToolRuntime at parity (§6.3).
- Capability-gate `QuestionBanner.jsx` keystroke/interrupt controls for non-PTY backends
  (no native menu to drive).
- `/api/ui-config` and `ModelPrice` are provider-blind today — make them provider-aware
  alongside the `provider:model` price re-key (§6.6).
- Cost-unit read-path: USD (API) vs quota vs SDK credits — the UI aggregate must not sum
  unlike units (ties into D3's "included" labeling).

---

## 13. References

- Six-lane study (this session): execution layer, core ports, contracts/events, daemon
  orchestration & MCP, permission/gateway, config/cost/persistence.
- Consolidates and supersedes an earlier uncommitted research pass (memory
  `agent-runtime-abstraction`); that pass's doc (`docs/agent-runtime-architecture.md`) was
  never committed to git. This ADR replaces it; its "must-fix gaps" are folded into §10/§12.
- Key seams cited: `core/src/use-cases/SpawnWorker.ts`, `core/src/ports/ProcessSupervisor.ts`,
  `core/src/services/PolicyGatewayService.ts`, `core/src/domain/mcp-resolution.ts`,
  `core/src/services/SqlBackedModeResolver.ts`, `spawner/worker.ts`, `spawner/claude-args.ts`,
  `contracts/src/events.ts`, `manager/container.ts`, `manager/shared/config.ts`,
  `manager/web/src/lib/messageParser.js`.
