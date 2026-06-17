# Eos Agent-SDK Backend Migration — Definitive Architecture & Migration Plan

**Status:** Design report (no implementation). **Audience:** Eos maintainer (expert). **Date basis:** 2026-06-17. **Scope:** add a `claude-sdk` `AgentBackend` that replaces the fragile PTY path for subscription users, streams real-time thinking, hosts tools in-process, and is multi-provider-ready — without touching the PTY path. All load-bearing claims were verified against the repository; the four adversarial reviews are folded into the design, not appended.

---

## 1. Executive summary

### What changes and why

Today every Claude session in Eos runs as an **interactive PTY child** (`node-pty` → `spawner/worker.ts`) so the user's Max/Pro subscription pays for tokens. That path is correct on billing but **fragile by construction**: a readiness gate waiting for a TUI composer glyph, bracketed-paste verified delivery with an echo/ACK retry ladder, JSONL transcript tailing over chokidar, post-turn settle windows defending against two independent fire-and-forget channels. It also **cannot** deliver real-time thinking — the transcript only ever commits *whole* thinking blocks, batch-flushed 150 ms–2.5 s after creation.

This plan adds a **`claude-sdk` backend** built on `@anthropic-ai/claude-agent-sdk`. It:

- **R1** — replaces the PTY path for subscription users (PTY stays as a first-class, selectable fallback, never removed).
- **R2** — streams **real-time thinking deltas** via `includePartialMessages` → `content_block_delta` → `thinking_delta`/`text_delta`.
- **R3** — **keeps subscription billing** by constructing a scrubbed OAuth env for the SDK-spawned `claude` binary.
- **R4** — is the first member of a **two-lane multi-provider** family (Kimi/DeepSeek later) that funnels through one canonical event pipeline so thinking/tools never fork.
- **R5** — provides Eos's tools as **direct in-process tools** via `createSdkMcpServer`/`tool()` with `ENABLE_TOOL_SEARCH=false`, gated by `canUseTool → PolicyGatewayService.decide()`.
- **R6** — is modular, configurable, SOLID, behind named design patterns.

### The key insight

**Eos's backend abstraction is already ~60% of the way there.** `core/src/ports/AgentBackend.ts` defines the seam (`AgentBackend`/`AgentSession`/`AgentCapabilities`/`WorkerHandle`/`AgentBackendRegistry`) with an `inproc` handle variant and an `onEvent` canonical sink **designed precisely for an in-process SDK backend**. `contracts/src/canonical.ts` already carries a backend-neutral `AgentEvent` union with reasoning blocks. `SqlBackedBackendResolver` already selects a backend per worker with parent-chain inheritance, persisted via `backend_kind`/`backend_profile` columns. `BackendKindSchema` already enumerates `"claude-sdk"`. The migration is therefore **overwhelmingly "adapters into an existing spine,"** not new architecture.

### The thesis

A `claude-sdk` backend **keeps subscription billing AND adds structured streaming**, so it can **replace** (not merely supplement) the PTY path for subscription users. The old "never use `claude -p`" rule existed only because `-p` historically drew a separate credit pool; that constraint's real intent is *"guarantee the subscription/OAuth credit path; never let an API key shadow it."* On the OAuth path with `ANTHROPIC_API_KEY` scrubbed, the SDK bills the subscription — satisfying the intent.

### The honest caveats (driving the plan's shape)

The Python proofs (`live_thinking.py`, `test_custom_tool.py`) and the policy facts are real, but **the TS specifics are Python-proven, not yet TS-verified**, and three adversarial findings materially reshape the build:

1. **The SDK is not "in-process" in the model-loop sense.** It **spawns the bundled `claude` native binary as a subprocess** over stdio. Billing auth is resolved by that **child** from the env it receives. "In-process" is accurate only for *Eos's tool host and event sink* — not the model loop. This reframes the billing guard from "set `options.env`" to "**prove the child's env is controlled** (replace, not overlay)."
2. **`blockId` does not exist in the SDK stream.** `RawMessageStreamEvent` carries only a numeric `index` that **resets per assistant message**. The live↔durable reconcile key must be **synthesized** from the partial message `uuid` + `index`.
3. **There is no durable render path for SDK messages today.** `app/ui/src/lib/messageParser.js:buildBlocks()` reads **only** `ev.type === "jsonl"` rows; `processAgentSignal` persists canonical messages as `ev.type === "agent_event"`, which `buildBlocks` ignores entirely — so a finished SDK turn's thinking/text/tools would **vanish** the moment streaming stops. A new decoder is required and is booked as a Phase-1 deliverable.

A hard **Phase-3 spike** gates the default cutover on empirically resolving these before any user-facing flip.

---

## 2. Current-state assessment

Three coexisting realities behind one port:

| Lane | State | One-line reality |
|---|---|---|
| **claude-cli (PTY)** | **complete, production** | The fragile-but-billing-correct path; thin 92-line adapter over the whole `spawner/` machinery. |
| **in-process (anthropic-api/openai/codex)** | **half-built scaffolding** | A real, tested Eos-hosted agentic loop (`ToolRuntime` + `ModelClient`) — but **non-streaming**, **API-key-billed**, **empty tool maps**, **allow-all gate**. The raw-API lane (Lane B), NOT the SDK lane. |
| **claude-sdk** | **empty enum slot** | A declared `BackendKind` with **no adapter** and **no `backendMap` entry**; resolving to it throws "unknown backend." |

**No real SDK is installed** in any package (`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, `openai`, `litellm` all absent — only `node-pty`).

### File status table

| File | Role | Status for this migration |
|---|---|---|
| `core/src/ports/AgentBackend.ts` | The seam (`start`/`attach`, `AgentSession`, `AgentCapabilities`, `WorkerHandle`, registry) | **Reuse**; +2 optional capability booleans |
| `contracts/src/canonical.ts` | Backend-neutral `AgentEvent` union; `BackendKind` incl `claude-sdk` | **Reuse**; +1 additive `delta` member |
| `contracts/src/backend.ts` | `BackendProfile`/`AuthRef`/`BackendDefaults` | **Reuse as-is** (models everything) |
| `core/src/services/SqlBackedBackendResolver.ts` | Per-worker selection + parent inherit | **Reuse as-is** |
| `core/src/use-cases/SpawnWorker.ts` | Spawn; backend branch | **Fix** verified `backendProfile: null` write bug |
| `core/src/use-cases/DispatchMessage.ts` | Dispatch; `attach` per kind | **Fix** verified `attach` no-fallback gap (Phase 5) |
| `core/src/use-cases/ProcessAgentSignal.ts` | Canonical reducer (`reduceAgentSignal`) | **Reuse**; verify wiring for inproc (see §5.4) |
| `core/src/services/PolicyGatewayService.ts` | Permission engine (Chain of Responsibility) | **Reuse verbatim** via `canUseTool` |
| `core/src/domain/permission-mode.ts` | `classifyTool` + `MODE_SPECS` | **Reuse as-is** |
| `contracts/src/tool-scope.ts` | `BLOCKED_BUILTIN_TOOLS` + `isEosControlTool` | **Reuse as-is** (single source) |
| `manager/container.ts` | Composition root; `backendMap`; `onAgentEvent` sink | **Edit**: register `claude-sdk`; add `delta` sink branch |
| `manager/backends/ClaudeCliBackend.ts` | PTY adapter | **Zero edits** |
| `infra/src/backends/InProcessBackend.ts` | In-process template | **Reuse as structural template only** (not `ToolRuntime` for SDK) |
| `infra/src/backends/{Anthropic,OpenAI}ModelClient.ts` | Raw-API ModelClients | **Lane B only** (DeepSeek/Kimi later) |
| `manager/shared/mcp-tool.ts` | `McpToolModule = {name, register(server, session)}` | **Refactor or adapt** (verified: no `zodShape`/`handler` fields — see §7.1) |
| `manager/orchestrator-mcp/tools/*`, `worker-mcp/tools/*` | 12 tool bodies | **Reuse bodies**; re-host (§7) |
| `scripts/hooks/auto-allow.sh`, `gateway/*` | PTY permission gateway | **Untouched**; SDK bypasses (uses `canUseTool`) |
| `manager/services/ModelCatalogService.ts` | `readOauthToken()` (Keychain/.credentials.json) | **Lift pattern** into `AuthResolver` (but see §4: token-source choice) |
| `spawner/claude-args.ts` | PTY child env builder (`...process.env`) | **Audit** for `ANTHROPIC_API_KEY` leakage (§4.5) |
| `app/ui/src/lib/messageParser.js` | `buildBlocks` (jsonl-only) | **Add** `agent_event` decoder (Phase 1 — see §6.4) |
| `app/ui/src/state/terminalStore.js`, `hooks/useLive.js` | Ephemeral high-freq SSE precedent | **Template** for `thinkingStore` + `agent:delta` |
| `app/ui/src/views/code/messages/{ThinkingLine,ProcessingLine}.jsx` | Thinking renderer / spinner | **New live renderer** (§6.5) — neither carries a live buffer today |

---

## 3. Goals, hard constraints, architecture rules

### Hard requirements

- **R1** — `claude-sdk` `AgentBackend` that **replaces** the fragile PTY path (PTY kept as fallback).
- **R2** — **real-time** thinking-block streaming to the UI.
- **R3** — **keep** the subscription-billed path working.
- **R4** — multi-provider readiness (Kimi/Moonshot, DeepSeek …) addable **without forking** the thinking/tool pipeline.
- **R5** — tools provided **directly as in-process tools**, incl `ENABLE_TOOL_SEARCH=false`.
- **R6** — modular, configurable, customizable, clean, SOLID, named design patterns.

### Non-negotiable architecture rules (bind every decision)

- **Clean-architecture direction** `contracts/ → core/ → infra/ → entrypoints(manager/)`, lint-enforced (`no-restricted-imports`). **No Node imports in `core/`.** Core uses the `Clock` port — never `Date.now()`.
- **Zod schemas in `contracts/` are the single source of truth** for IPC shapes. New event type ⇒ enum/union in `contracts/`.
- **Node strip-only TS:** no parameter properties; explicit field + assignment. `safeStringify` for non-serializable values. `e instanceof Error ? e.message : String(e)` in catch.
- **Prescribed touch-points** for HTTP endpoint / event type / MCP tool / backend adapter / web view — reuse existing seams, do not reinvent.
- **`~/.eos` is user data** — never `rm`/`mv`; agent smoke tests use `EOS_HOME=$(mktemp -d)`.
- **Cost is display-only** — `costMode` is a label, not a guardrail (§11).

---

## 4. The subscription-vs-billing finding (R3)

### 4.1 The decisive facts (verified)

1. **Subscription billing currently works for the Agent SDK.** Anthropic's planned June-15-2026 change (moving Agent SDK + `claude -p` to a separate per-month credit pool) was **PAUSED** on June 16. The official support article (15036540) states verbatim that "nothing has changed: Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits." Validated in Python on the user's subscription.
2. **Auth precedence (confirmed):** `cloud creds > ANTHROPIC_AUTH_TOKEN > ANTHROPIC_API_KEY > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN > interactive login`. **`ANTHROPIC_API_KEY` silently wins** over the OAuth token and bills the API pool.
3. **The TS SDK spawns the bundled `claude` binary** as a subprocess (optional-dep native binary; `pathToClaudeCodeExecutable` overrides). The **child** resolves auth from the env it receives.

### 4.2 The corrected mental model (adversarial must-fix [subscription] #1)

The SDK is **not** a pure in-process HTTP client. It is a **subprocess driver**. Therefore the billing guarantee is *"control the child's environment,"* not *"set `options.env`."* Two facts must be **proven in the spike**, not assumed:

- whether `options.env` **replaces** vs **merges over** the child's env (today's PTY builder `spawner/claude-args.ts:24` does `...(process.env)` overlay — if the SDK does the same, a daemon-level `ANTHROPIC_API_KEY` leaks into the child despite a local strip);
- whether the bundled binary reads `~/.claude/.credentials.json` **directly** (so OAuth may "work" even with no token injected — masking a misconfig that flips to API billing elsewhere).

### 4.3 `AuthResolver` port + a single coherent token lifecycle (must-fix [subscription] #6)

```ts
// core/src/ports/AuthResolver.ts
export interface ResolvedAuth { scheme: "oauth" | "apikey" | "none"; token?: string; apiKey?: string; baseUrl?: string; }
export interface AuthResolver { resolve(auth: AuthRef | undefined): Promise<ResolvedAuth>; }
```

```ts
// infra/src/auth/SubscriptionAuthResolver.ts (sketch)
//   subscription -> the LONG-LIVED setup-token (sk-ant-oat01-..., ~1yr from `claude setup-token`),
//                   NOT ModelCatalogService.readOauthToken()'s cached ~/.claude accessToken.
//   env          -> { scheme:"apikey", apiKey: process.env[ref] }   (Lane B: DeepSeek/Kimi)
//   keychain     -> security find-generic-password -s <ref>
//   Lazy at launch, NEVER persisted, NEVER logged.
```

**Token-source decision (corrected):** the design originally proposed reusing `ModelCatalogService.readOauthToken()`. That reads the cached `~/.claude` access token, which is kept fresh **only because interactive `claude` runs and refreshes it**. If the SDK *replaces* PTY, interactive `claude` may never run, the cached token goes stale, `readOauthToken()` returns `null`, and **every SDK worker silently drops to fallback/no-auth** — defeating "replace PTY." For a PTY-replacing daemon, the correct source is the **long-lived `claude setup-token` (`oat01`)**. The resolver must read/refresh that, and the spike must confirm refresh behavior. `readOauthToken()`'s expiry-check pattern is still a useful reference, but the token itself is the setup-token.

### 4.4 BillingGuard env chokepoint (env **replacement**, not overlay)

```ts
// infra/src/backends/sdk/billing-env.ts
export function buildBillingGuardEnv(auth: ResolvedAuth, spec: AgentLaunchSpec, daemonUrl: string): Record<string,string> {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = process.env; // strip the silent winners
  return {
    ...rest,                                              // preserve PATH etc. (assumes env REPLACES child env — spike-verified)
    ...(auth.scheme === "oauth" ? { CLAUDE_CODE_OAUTH_TOKEN: auth.token! } : {}),
    ENABLE_TOOL_SEARCH: "false",                          // R5 (spike-contingent; settings.toolSearchEnabled:false is plan B — §7.2)
    EOS_SPAWNED: "1", EOS_WORKER_ID: spec.workerId, EOS_DAEMON_URL: daemonUrl,
    // ANTHROPIC_BASE_URL deliberately UNSET (a proxy URL disables subscription auth)
  };
}
```

The `...rest` spread is **only safe if `options.env` is the exclusive child env source.** If the spike shows it *overlays*, the guard must instead pass a complete, explicitly-constructed env and confirm no parent `ANTHROPIC_API_KEY` reaches the child.

### 4.5 Audit the PTY fallback's own env (must-fix [subscription] #5)

The PTY path is the designated R3 safety net, yet `spawner/claude-args.ts:24` builds the child env as `...(process.env)` — so if the daemon carries `ANTHROPIC_API_KEY` (plausible: `container.ts:528` reads it for the `anthropic-api` backend), **today's PTY worker may already bill the API pool, not the subscription.** This is **in scope**: either confirm the daemon never carries `ANTHROPIC_API_KEY` when subscription PTY workers run, or apply the same scrub to the PTY child env. **The "zero edits to PTY" invariant may be incompatible with a true R3 guarantee** — this is a maintainer decision (§12).

### 4.6 Runtime assertion + selection-time fallback (must-fixes #2, #4)

- **No invented field.** The design must **not** assert R3 safety on an unconfirmed `tokenSource`/`apiKeySource` message field — there is no evidence such a field exists on any TS-SDK message. The spike must find the *actual* signal, in priority order:
  1. **Pre-launch invariant (always available):** assert the injected token is `sk-ant-oat01-…` **and** no `ANTHROPIC_API_KEY` is in the constructed child env. This is the **minimum guaranteed guard** and does not depend on any SDK field.
  2. An out-of-band probe (e.g. `claude /status` against the same env) or a usage/cost field on `ResultMessage`, if the spike confirms one.
- **Fallback fires on auth-source assertion failure, not just `resolve()==="none"`** (must-fix #4). "Creds present" ≠ "creds bill subscription" (a cancelled-but-not-expired token still resolves to `oauth`). If no post-launch signal can be obtained, the **only safe degradation is keeping `defaults` on PTY** until the spike proves an assertable signal — stated explicitly as a gate (§10, Phase 7).
- **Selection-time fallback:** if `resolve({kind:"subscription"})` returns `scheme:"none"`, the spawn route falls back to `claude-cli` for that worker (logged `sdk_auth_unavailable_fell_back_to_pty`).

### 4.7 ToS / enforcement risk — distinct from billing (must-fix [subscription] #3)

Official Agent SDK docs say *"Set your API key"* and restrict third-party subscription bridging: *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products … Please use the API key authentication methods."* Eos **is** such a harness. This is a **separate risk row** from the billing-pause (§11) and arguably larger: if Anthropic actively blocks OAuth-via-SDK harnesses, the SDK path dies regardless of env hygiene. **The PTY interactive path is the *sanctioned* path** — a policy safety net, not just a billing one. The spike should check whether OAuth-driven SDK sessions are rate-limited/blocked differently than interactive use. This is the strongest argument for keeping PTY first-class indefinitely.

---

## 5. Target architecture

### 5.1 The merge in one paragraph

Add a `claude-sdk` `AgentBackend` adapter as a **sibling of `InProcessBackend`** (reusing its *structural* template — live-session map, `onEvent`, abort interrupt, `inproc` handle — but **never** `ToolRuntime`, which is the non-streaming raw-API loop). It runs the SDK's own loop, streams thinking via `includePartialMessages`, hosts Eos's tools in-process via `createSdkMcpServer` (`ENABLE_TOOL_SEARCH=false`), gates them through `canUseTool → PolicyGatewayService.decide()`, and keeps subscription billing via the §4 BillingGuard. It emits the existing canonical `AgentEvent` union **plus one additive `delta` event** on an ephemeral `agent:delta` SSE topic modeled on the verified `terminal:chunk` precedent. **The PTY path is touched zero times.** Multi-provider (Kimi/DeepSeek) is a designed-now/built-later **Lane B** on `ToolRuntime`/`ModelClient`, funneling through the same canonical union.

### 5.2 Named design patterns (R6)

| Pattern | Where |
|---|---|
| **Ports & Adapters (Hexagonal)** | `AgentBackend` port; `ClaudeSdk`/`ClaudeCli`/`InProcess` adapters; new `AuthResolver` port + adapter |
| **Strategy** | Per-worker backend selection (`SqlBackedBackendResolver`); the two lanes; per-mode `MODE_SPECS` |
| **Registry** | `AgentBackendRegistry` (`backendMap`) |
| **Abstract Factory** | `createClaudeSdkBackend(deps)`; per-spawn `InProcessEnvFactory(spec)`; per-worker **session factory** (§7.3) |
| **Adapter** | `SdkToolHost` (`McpToolModule` → SDK `tool()`); `OpenAiCompatibleModelClient` |
| **Anti-Corruption Layer** | `SdkEventMapper`; per-provider `ModelClient` ACLs; existing `spawner/canonical-map.ts` |
| **Bridge** | `SdkPermissionBridge` (`canUseTool` ↔ `PolicyGatewayService`) |
| **Observer / event-sink** | `AgentStartCallbacks.onEvent` → reducer + bus; `agent:delta` SSE topic |
| **Capability object** | `AgentCapabilities` drives UI by data — no `instanceof`/kind branching |
| **Chain of Responsibility** | `PolicyGatewayService.decide` (structural → rule → mode → default) |
| **Template Method** | `ToolRuntime.runTurn` (Lane B) |
| **Null Object / fallback** | unknown-kind / creds-missing → `claude-cli` |

### 5.3 Component / flow diagram

```
                 ┌──────────────────────── manager/ (daemon) ────────────────────────┐
 spawn route ──► SqlBackedBackendResolver ──► backendMap.get(kind) ──► AgentBackend.start(spec, cb)
                                                                              │
            ┌─────────────────────────────────────────────────────────────────┼────────────────────────────┐
            ▼ kind="claude-cli"                  ▼ kind="claude-sdk"            ▼ kind="openai"/"anthropic-api"
   ClaudeCliBackend (PTY)              ClaudeSdkBackend (LANE A)        InProcessBackend (LANE B)
   spawner/worker.ts child            spawns `claude` binary subproc    ToolRuntime + ModelClient (Eos loop)
   events via HTTP ingest             SdkEventMapper (ACL)              per-provider ModelClient ACL
   (onEvent UNSET)                    cb.onEvent(AgentEvent)            cb.onEvent(AgentEvent)
            │                                   │                                   │
            └───────────── canonical AgentEvent union ──────────────────────────────┘
                       { message | delta | turn | activity | usage | session | permission_request | question_request }
                                                │
                       container.onAgentEvent(workerId, event)
                          ├─ event.type==="delta"  ──► bus.publish("agent:delta", payload)  ──► (return; no persist/reduce)
                          └─ else ──► events.append(...)  +  reduceAgentSignal(...)  +  bus("worker:change")
                                                │
                                  SSE broadcaster ───────────────────────────────────────┐
                                   • change-ping (whole events) ► refetch GET /events     │
                                   • agent:delta (payload)      ► thinkingStore (ephemeral)│
                                                                                          ▼
                              app/ui:  messageParser.buildBlocks (DURABLE: jsonl + NEW agent_event decoder)
                                       + thinkingStore (LIVE deltas)  + live ThinkingLine renderer + ProcessingLine spinner
```

### 5.4 The port — three additive changes only

The port is **structurally complete; do not redesign it.** Verified: `WorkerHandle = {kind:"http",port,pid} | {kind:"inproc",ref}` and `AgentStartCallbacks.onEvent` already model in-process backends.

**(a) `AgentCapabilities` — two additive optional fields:**

```ts
// core/src/ports/AgentBackend.ts — AgentCapabilities (additive only)
export interface AgentCapabilities {
  readonly interrupt: boolean;
  readonly keystroke: boolean;
  readonly runtimeModelSwitch: boolean;
  readonly runtimePermissionSwitch: boolean;
  readonly reportsMessageEvents?: boolean;
  readonly streamingThinking?: boolean;   // NEW: emits `delta` events; UI gates live renderer on DATA, not kind
  readonly resumable?: boolean;           // NEW: survives daemon restart via persisted session id
}
```

**(b) No new port method, no new handle variant, no `AgentLaunchSpec` change.** claude-sdk reuses `{kind:"inproc", ref: workerId}`; per-profile config rides the **existing** `AgentLaunchSpec.backendOptions` carrier.

**(c) Two pre-existing gaps this migration closes (both additive, both PTY-safe):**
1. **`backendProfile` persisted as `null`** (verified `SpawnWorker.ts`) — thread the resolved `profileName` into `backendOptions.profileName`, persist into the existing `backend_profile` column. PTY just starts writing a non-null value.
2. **Resume hardcoded to `claudeCliBackend`** (verified `resume-helpers.ts`) — make resume backend-aware (`c.backends.get(row.backend_kind)`, gated on `capabilities.resumable`). For `claude-sdk`, resume = re-`start()` with `options.resume: <session_id>`. (Phase 6.)

### 5.5 `reduceAgentSignal` wiring — verify, don't assume (must-fix [thinking] #5)

The design's original conflict-resolution R-1 claimed `reduceAgentSignal` is "already the live driver, no wiring step needed." **Adversarial review found this contradicts two source comments** (`ProcessAgentSignal.ts:6-9` "NOT yet wired into the daemon route … exercised only by unit tests"; `SpawnWorker.ts:89` "Unused by out-of-process backends"). Even if the PTY `hook`/`jsonl` path was retrofitted through `toCanonical`, the **inproc `onEvent` → `processAgentSignal` → `reduceAgentSignal` path is not proven live in production.** The SDK lane's WORKING-heal and settle-window guarantees ride on this reducer.

**Resolution (do not assert it away):** Phase 1 includes an explicit verification task — with file evidence, confirm that `container.onAgentEvent` actually invokes `processAgentSignal`/`reduceAgentSignal` for an `inproc` backend's `onEvent` sink **today**. If it does (the `FakeAgentBackend`/`InProcessBackend.test.ts` end-to-end test suggests the pipeline exists), document the evidence and proceed. If it does **not**, reinstate the wiring as an explicit Phase-1 step. Either way the cost is small; the point is to stop asserting a contested premise.

### 5.6 Selection & registration

One `backendMap` entry (`manager/container.ts ~L541`); selection unchanged via `SqlBackedBackendResolver`. **No separate `features` flag** — selection is fully controlled by the default-profile switch + creds presence. (A transient `EOS_ENABLE_SDK_BACKEND` env guard is allowed *only* during the Phase-3 spike, removed at GA.)

---

## 6. Real-time thinking streaming pipeline (R2)

The SDK half of R2 **holds and is verified**: `includePartialMessages:true` yields `SDKPartialAssistantMessage{type:"stream_event", event: RawMessageStreamEvent, uuid, session_id, parent_tool_use_id}`; `thinking_delta`/`text_delta` arrive incrementally inside `content_block_delta`. `thinking:{type:"adaptive", display:"summarized"}` is required (Opus 4.7+ defaults `display` to `omitted`). The **Eos half** needs the additive contract + the two blocker fixes below.

### 6.1 Contract — one new `AgentEvent` member, with a **synthesized** `blockId`

```ts
// contracts/src/canonical.ts — ADD to AgentEventSchema discriminatedUnion
export const DeltaEventSchema = z.object({
  type: z.literal("delta"),
  channel: z.enum(["reasoning", "text"]),
  phase: z.enum(["start", "append", "stop"]),
  blockId: z.string(),          // SYNTHESIZED (see §6.2) — NOT the SDK's resettable numeric index
  text: z.string().default(""), // empty on start/stop
});
```

Additive to a discriminated union → existing `switch(type)` consumers hit `default` and are unaffected. PTY never emits it.

### 6.2 `blockId` synthesis (must-fix [thinking] #1 — blocker)

**Verified:** `RawMessageStreamEvent` carries **no stable block id** — only a numeric `index` that **resets to 0 at the start of each assistant message.** Across a multi-tool turn (assistant → tool_use → tool_result → assistant …) two distinct thinking blocks both arrive at `index 0`, so a store keyed on raw index collides.

**Rule:** `SdkEventMapper` synthesizes `blockId = ${assistantMessageUuid}:${index}` using the `uuid` on `SDKPartialAssistantMessage`. The **identical** synthesized id is stamped onto the durable canonical `message` event's block (§6.4) so the UI reconciles live↔durable without double-render. The mapper must prove collision-freedom across interleaved tool turns (distinct `uuid` per assistant message ⇒ distinct id even at the same index).

### 6.3 `SdkEventMapper` mapping table (the ACL)

| SDK message | Canonical `AgentEvent` |
|---|---|
| `system / subtype:"init"` | capture `session_id` → emit `session:{phase:"ready"}`; persist `session_id` via the existing lifecycle enrichment path |
| first stream activity after a user message | `turn:{phase:"started"}` ← **the WORKING-heal trigger for streaming-only turns** |
| `content_block_start (thinking)` | **lazy-open** (see §6.6) — defer until first non-empty `thinking_delta` |
| `content_block_start (text)` | `delta:{channel:"text", phase:"start", blockId}` |
| `content_block_delta / thinking_delta` | `delta:{channel:"reasoning", phase:"append", blockId, text}` |
| `content_block_delta / text_delta` | `delta:{channel:"text", phase:"append", blockId, text}` |
| `content_block_delta / input_json_delta` | **dropped from the live channel** (tool-args; see §6.7) |
| `content_block_delta / signature_delta`, `citations_delta` | **dropped from the live channel** |
| `content_block_stop` | `delta:{phase:"stop", blockId}` (only if a live block was opened) |
| `assistant` (complete) text/reasoning block | `message:{role:"assistant", blocks:[…], blockId stamped]}` ← **durable, persisted** |
| `assistant` `tool_use` block | `message:{…[tool_call]}` + `activity:{kind:"tool_started", callId, toolName}` |
| tool result (in-stream) | `message:{role:"tool", blocks:[tool_result]}` + `activity:{kind:"tool_finished", callId}` |
| `result` (ResultMessage) | `usage:{…}` then `turn:{phase:"ended"}` |
| empty/signature-only thinking (#337) | **suppressed** durable (`text.trim()===""`) + lazy-open never fires live |

### 6.4 Durable render path for SDK messages (must-fix [thinking] #2 — blocker)

**Verified:** `app/ui/src/lib/messageParser.js:buildBlocks()` constructs blocks **only** from `ev.type === "jsonl"` rows (`if (ev.type !== "jsonl") continue;` then branches on `p.kind === "assistant_text" | "thinking" | "tool_use"`). But the SDK lane persists canonical messages as `ev.type === "agent_event"` (via `processAgentSignal → logEvent(..., "agent_event", event)`). `buildBlocks` has **no `agent_event` branch** — so once the live delta finalizes and the ephemeral buffer drops, the persisted whole block renders as **nothing** and the thinking/text/tools **vanish**.

**Phase-1 deliverable (not hand-wave):** add an **`agent_event` → blocks decoder** to `buildBlocks`. It maps canonical `message{blocks:[reasoning|text|tool_call|tool_result]}` into the existing render-block kinds (`thinking`/`assistant`/tool blocks), preserving order and carrying the synthesized `blockId`. (Alternative considered and rejected as messier: have `ClaudeSdkBackend` persist `jsonl`-shaped rows the existing parser already understands — rejected because it leaks PTY-wire shapes into a non-PTY backend and undermines the canonical model.) **Reload test required:** a finished SDK turn's thinking/text/tools survive a refetch with no live buffer present.

### 6.5 The live renderer (must-fix [thinking] #3 — neither existing component fits)

**Verified:** `ProcessingLine.jsx` renders **only** a spark span + elapsed timer — **no text slot**; calling it the "thinking carrier" is wrong (it is the spinner). `ThinkingLine.jsx` carries text but is explicitly built for **immutable** one-shot text (its comment: "one event, no merge, React never diffs"; `useBlurInReveal` animates only an appended tail keyed on `[html, enabled]`) — feeding it token-rate growth thrashes the reveal accounting.

**Design:**
- **`app/ui/src/state/thinkingStore.js`** — clone of `terminalStore.js` (`applyChunk`/`applyDone` shape). Keyed `workerId:blockId`; accumulates `text` on `append`; drops on `phase:"stop"` finalize or `turn:ended`.
- **A NEW live component** reads `thinkingStore` directly (bypassing `useBlurInReveal`) for the **live** phase. When the durable `message` row lands via the normal events refetch, the existing **immutable** `ThinkingLine` renders the persisted block and the live buffer is swapped out **by `blockId`**. The handoff frame is defined explicitly: the live component unmounts for a `blockId` exactly when a durable block with that `blockId` appears in `buildBlocks` output — no flash, no duplicate.
- `ProcessingLine` remains the motion/elapsed anchor only.

### 6.6 Lazy-open for signature-only blocks (must-fix [thinking] #6)

On `#337`-style turns the SDK emits `content_block_start{thinking}` + `content_block_stop` with only `signature_delta` between (no `thinking_delta`). To avoid an empty "thinking ·" line that must then vanish, **defer the live `start` until the first non-empty `thinking_delta` arrives** (lazy-open). A signature-only block therefore never opens a live line, matching the durable suppression (`buildBlocks` already skips `text:""` thinking).

### 6.7 `input_json_delta` is on the same channel (must-fix [thinking] #4)

**Verified:** during a `tool_use` block, `content_block_delta` events of type `input_json_delta` (partial tool-arg JSON) ride the **same** channel as `thinking_delta`/`text_delta`. The mapper must **explicitly enumerate** the handled subtypes (`thinking_delta`, `text_delta`) and **explicitly drop** `input_json_delta`/`signature_delta`/`citations_delta` from the live delta channel. Tool calls become a **durable `message` block** built at `content_block_stop`. This makes the "correct order relative to tool_use" claim provable.

### 6.8 State safety — deltas never reach the reducer

Deltas are **filtered at the daemon `onAgentEvent` sink before `reduceAgentSignal`** (publish `agent:delta`, then `return`) — they never persist a row, never touch state. WORKING-heal on a streaming-only turn comes from the `turn:{phase:"started"}` event the adapter emits at turn start. Settle-window safety is automatic (deltas don't touch state; `turn:ended` opens the settle window). No new reducer case. (Contingent on §5.5 verification.)

### 6.9 Transport — ephemeral SSE topic (verified `terminal:chunk` precedent)

```ts
// manager/container.ts onAgentEvent — ADD before processAgentSignal(...)
if (event.type === "delta") {
  bus.publish("agent:delta", { workerId, channel: event.channel, phase: event.phase, blockId: event.blockId, text: event.text });
  return;                       // NEVER events.append, NEVER reduceAgentSignal
}
```

```js
// app/ui/src/hooks/useLive.js — beside the verified terminal:chunk branch (~line 108)
if (data.reason === "agent:delta") { applyThinkingDelta(data.payload ?? {}); return; } // skips scheduleRefetch
```

No SQLite row per token. Relayed with payload, bypassing the events table — exactly like `terminal:chunk`/`fs:change`/`git:change`.

### 6.10 Fidelity caveat (must-fix [thinking] #7)

`display:"summarized"` streams a **summary**, emitted in coarser chunks than raw token-by-token CoT. R2 is satisfied *in kind*; the plan should not promise raw-CoT smoothness. The spike must record actual delta cadence for thinking vs text so the live renderer's animation is tuned to measured granularity.

**R2 is SDK-lane-only by physics** — the PTY transcript is batch-flushed, so real-time is impossible there. PTY keeps whole-block thinking as graceful degradation.

---

## 7. Tools as direct in-process tools + permission gating (R5)

### 7.1 The interface gap (must-fix [tools] #1 — blocker)

**Verified:** `McpToolModule<S> = { readonly name; register(server: McpServer, session: S): void }` — there is **no `zodShape` and no `handler` field.** The Zod schema and async handler are captured **inside** `register()` via `server.registerTool(name, {inputSchema}, asyncHandler)`. So the sketched `tool(m.name, desc, m.zodShape, m.handler)` **does not compile** against today's code, and "re-host the 12 modules as-is" is false as written.

**Two concrete options — the plan must pick one and book its cost:**

- **(A) Refactor `McpToolModule` to a data contract:** `{ name, inputSchema, handler(session, args) }`, and rewrite all 12 modules + both registries (`orchestrator-mcp/tool-registry.ts`, `worker-mcp/tool-registry.ts`) + the existing `McpServer` registration shim to consume it. Cleaner long-term; a real cross-cutting change (not zero-cost).
- **(B) Capturing fake-`McpServer` adapter (recommended for lower blast radius):** a shim `McpServer` whose `registerTool(name, config, handler)` records the `(name, inputSchema, handler)` triple; `SdkToolHost` calls each module's `register(shim, session)`, then re-emits the captured triples as SDK `tool()` entries. **Feasible** — the existing `withToolDescriptions` Proxy already intercepts `registerTool` the same way — but it is **net-new infra** that must also replicate the description-injection Proxy. 

Either way, **do not claim 1:1 reuse**; book the adaptation as explicit work.

### 7.2 `SdkToolHost` — re-host the 12 tool bodies

```ts
// infra/src/backends/sdk/SdkToolHost.ts (using option B: capturing shim)
build(spec: AgentLaunchSpec): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } {
  const session = makeSessionForSpec(spec);                 // §7.3 — per-worker, NOT process.env
  const orchestrator = createSdkMcpServer({ name: "orchestrator", version: "1.0.0",
    tools: capture(deps.orchestratorToolModules, session) });   // capture() drives register() on a shim
  const workerMods = [...deps.workerToolModules,
    ...(spec.backendOptions?.collaborate ? deps.peerToolModules : [])]; // collaborate-gated at launch
  const worker = createSdkMcpServer({ name: "worker", version: "1.0.0", tools: capture(workerMods, session) });
  const servers = spec.isOrchestrator ? { orchestrator, worker } : { worker }; // ask_user/spawn_worker orchestrator-only
  return { mcpServers: servers, allowedTools: Object.values(servers).flatMap(toolNamesOf) };
}
```

- **Server names MUST stay `orchestrator`/`worker`** → tool names `mcp__orchestrator__*`/`mcp__worker__*` (verified: `isEosControlTool` prefix-match and `classifyTool` always-allow-`mcp__*` depend on it; prompts reference `{{*_TOOL}}`).
- Descriptions from the existing prompt library via `renderToolDescriptions` (fed into `tool()` instead of, or via, the Proxy).
- **`ENABLE_TOOL_SEARCH=false`** via `options.env` (R5). **Spike-contingent** (must-fix [tools] #5): the env-var form is Python-empirical; the TS SDK may instead honor a settings field. **Plan B = `settings.toolSearchEnabled:false`** — the **proven** mechanism the PTY path already uses (`spawner/settings.ts`). Name both; pick at integration.
- **Deleted for SDK workers only (PTY keeps all):** `StdioServerTransport` plumbing, the `mcpReadyFlag` boot-prompt-release dance (no readiness race in-process).

### 7.3 Per-worker identity — the systemic fix (must-fix [tools] #2 — blocker)

**Verified:** identity is **process-global** today — `OrchestratorSession.selfId = process.env.EOS_WORKER_ID`, cwd from a one-shot `GET /workers/<selfId>`; worker `SessionContext` reads `EOS_WORKER_ID`/`EOS_COLLABORATE` once at module load; `orchestrator-mcp.ts` builds a single module-global `session`. This works only because **each worker gets its own MCP subprocess.** In-process — the whole point of R5 — **one daemon hosts many SDK workers**, so there is no per-process env to key on.

**Requirement (systemic, not point-fixes):** every tool's session must be **per-invocation / per-worker**, bound from `AgentLaunchSpec` at `SdkToolHost.build(spec)` time:
- a **per-spec session factory** `makeSessionForSpec(spec)` produces `{ selfId: spec.workerId, cwd: spec.cwd, isGitRepo(), collaborate: spec.backendOptions?.collaborate, api }` — **never** reading `process.env` at call time;
- `build()` runs **once per SDK worker**; the captured tool handlers close over that worker's session;
- **prove** no reused tool body reads `process.env` at call time (audit `session.selfId`/`session.cwd`/`session.api` call sites).
- **`spawn_worker` cwd gotcha (verified):** its git probe must run against `spec.cwd`, not the daemon `process.cwd()` — the SDK server runs *in* the daemon. Captured in the per-spec session.

Without this, concurrent in-process workers **cross-wire identities** — a correctness blocker, not a nicety.

### 7.4 `SdkPermissionBridge` — `canUseTool` over the existing engine

```ts
// infra/src/backends/sdk/SdkPermissionBridge.ts
make(workerId: string): CanUseTool {
  return async (toolName, input, { signal }) => {
    if (isBlockedBuiltinTool(toolName))                              // AskUserQuestion hard-deny (tool-scope.ts, single source)
      return { behavior: "deny", message: "use mcp__orchestrator__ask_user" };
    const d = await deps.policyGateway.decide({ workerId, toolName, input /*, agentId */ });
    return d.behavior === "allow"
      ? { behavior: "allow", updatedInput: d.updatedInput ?? input }  // shape verified near-1:1 with Decision
      : { behavior: "deny", message: d.message ?? "denied" };
  };
}
```

- **Reused unchanged:** `PolicyGatewayService` + `classifyTool` + `MODE_SPECS` + `PendingRepo` long-poll + resolver Map (the `ask` verdict awaits the same parked Promise — `canUseTool` is async, tolerates day-long waits) + `policy.yaml` + `tool-scope.ts` + web `PermissionBanner`/`QuestionBanner` + `permission_pending`/`pending:created` events.
- **`PreToolUse`/`PostToolUse` hooks emit `activity` ONLY** (`tool_started`/`tool_finished`). **Single decision authority = `canUseTool`** (avoids the dual-gate confusion the PTY path documents).
- **Deleted for SDK workers only (PTY keeps):** `scripts/hooks/auto-allow.sh`, the `gateway/` MCP server, the `/policy/decide` curl round-trip.

### 7.5 Bash-safety is NOT a parity must-fix (must-fix [tools] #3 — corrected claim)

**Corrected:** the earlier design framed "fold `StandalonePolicy` Bash-safety into `PolicyGatewayService`" as a parity gate. **That premise is wrong.** Verified: **all daemon-managed workers (PTY included)** carry `EOS_DAEMON_URL`/`EOS_WORKER_ID`, so `gateway/server.ts` selects **`DaemonProxyPolicy`**, which forwards verbatim and applies **no** Bash-safety. The `rm -rf`/`git push`/`sudo`/`curl --max-time` rules live **only** in `StandalonePolicy`, selected **only** when those env vars are **absent** (non-daemon interactive sessions). Therefore SDK workers going through `PolicyGatewayService.decide` are at **exact parity** with today's daemon PTY workers — they **lose nothing**.

The fold is **legitimate optional hardening** (it would add protection *neither* path has today) but is **not required for R5 parity** and **does not gate Phase 4/7.** Re-labeled accordingly in §10.

### 7.6 `agentId` subagent guard

The step-0 `isEosControlTool` guard needs `canUseTool` to surface a subagent id. The spike confirms whether the TS SDK exposes one. Until then Eos keeps **daemon-level** worker spawning (no SDK `agents:{}`), so every worker has its own DB row/identity and the guard degrades **fail-closed** (deny control-plane tools on missing id).

### 7.7 Long-poll await lifecycle (must-fix [tools] #6)

`ask_user`/`ask_peer`/`respond_to_peer` are register-then-poll with **no TTL** (verified `ask_peer.ts` loops forever on `setTimeout`). In a subprocess this is harmless; **in-process each holds an open async frame in the daemon for days.** The SDK passes an `AbortSignal` to `canUseTool`/`tool()` — but the reused poll-loop bodies **do not honor any signal.** **Requirement:** thread the SDK tool invocation's `AbortSignal` into the long-poll bodies so interrupt/stop/daemon-restart **deterministically cancels** them; otherwise an interrupted SDK worker leaks a forever-polling timer. (If threading is deferred, document the leaked-timer risk + a sweep.)

### 7.8 Daemon supervision stays daemon-side

SDK `agents:{}` subagents are ephemeral, in-process to one query, **not** independently observable/controllable/persistent. Eos keeps its orchestrator-mcp `spawn_worker` (daemon spawns a new `claude-sdk` `AgentSession` per worker with its own DB row/mode/cost/queue/pane). **Do not** delegate worker spawning to SDK subagents.

---

## 8. Multi-provider design (Kimi/DeepSeek) — designed now, built later (R4)

### 8.1 Two lanes, one canonical pipeline

```
Lane A (SDK loop):     SDKMessage stream ──SdkEventMapper(ACL)─────┐
Lane B (Eos loop):     OpenAI/DeepSeek SSE ──OpenAiCompatMC(ACL)───┤   ← all ACLs target the SAME union
                       Anthropic Messages   ──AnthropicMC(ACL)─────┤
                                                                    ▼
        canonical AgentEvent { message | delta | turn | activity | usage | session | permission_request | question_request }
```

The convergence holds **for the reasoning/text delta channel**: both lanes emit the same `delta{channel,phase,blockId,text}` (§6), so the UI thinking renderer is the single sink — no fork.

### 8.2 Two real forks remain (must-fix [tools] #4 — honest scoping)

1. **Permission gating differs structurally.** Lane A gates via the SDK's `canUseTool` callback (SDK owns the loop). Lane B gates via `ToolRuntime`'s `ToolGate.decide` inside the Eos-owned loop. These are **two integration points**, both bound to `PolicyGatewayService` — adding a Lane-B provider does **not** reuse Lane A's `SdkPermissionBridge`.
2. **Tool-call shape divergence is non-trivial.** OpenAI-compatible providers (DeepSeek/Kimi) stream `tool_calls[].function.arguments` as **string fragments** across SSE chunks that must be **buffered/concatenated**, and DeepSeek/Kimi **require `reasoning_content` to be echoed back** across tool turns or the API errors. These quirks live in each provider's ACL.

**Honest R4 acceptance criterion:** "add Kimi/DeepSeek = one `BackendProfile` + one `prices` entry, zero pipeline code" is **true only once `OpenAiCompatibleModelClient` + `streamTurn?` exist** (Phase 8 is real adapter work). The **first** OpenAI-compatible provider is adapter work; the **second** that matches an already-built ACL (Kimi vs DeepSeek both use `reasoning_content`) is config-only. OpenAI Responses' `reasoning_summary_text` is a *different* field → a different ACL.

### 8.3 Reserved seams (Phase 8, not built now)

```ts
// core/src/ports/ModelClient.ts — ADD optional (ISP; non-streaming adapters unaffected)
streamTurn?(messages: ModelMessage[], onDelta: (d: { channel: "reasoning"|"text"; text: string }) => void): Promise<ModelTurn>;
```

- `ToolRuntime.runTurn` prefers `streamTurn` when present, emitting the **same** `delta` events from §6.
- **One** `OpenAiCompatibleModelClient` (Adapter + ACL), param-configured `{baseUrl, model, auth, reasoningField}`, covers DeepSeek (`reasoning_content`), Kimi (`reasoning_content`), OpenAI Responses (`reasoning_summary_text`).
- **Lane-B threading fixes (verified gaps):** thread `ResolvedBackend.{model,baseUrl,auth,params}` through `backendOptions`; move static `backendMap` in-process construction (env-baked at `container.ts:527-540`) into per-spawn `InProcessEnvFactory(spec)`; replace hardcoded Anthropic `priceFor` substring matcher with a `profile.pricing`-keyed lookup + honor `costMode` (display-only).
- **Reject** LiteLLM-via-`ANTHROPIC_BASE_URL` as default (disables subscription billing + adds an external process); keep only as an optional escape-hatch profile.

---

## 9. Data-model + config changes

### 9.1 Migrations — **zero new columns**

- **No `backend_session` migration.** Reuse the existing `session_id` column; the SDK `system/init` `session_id` writes it via the verified `lifecycle:session_captured` enrichment path.
- `backend_kind`/`backend_profile` already exist (migrations 020-022).
- **Schema work = the `backendProfile:null` write-bug fix** (§5.4c) — a code change, not a migration.

### 9.2 Boot reconciliation (net-new, Phase 6)

In-memory SDK sessions don't survive restart. On daemon boot, for `backend_kind="claude-sdk"` rows with no live registry entry:
- if `capabilities.resumable` **and** `session_id` present → re-`start()` with `options.resume` (resume);
- else → mark **`SUSPENDED`** (state exists, verified).
PTY rows reconcile by port as today. Lane-B rows mark stale. The SDK-forked `claude` child carries **no `eos-<name>-` temp prefix**, so cleanup is via `SdkLiveSession.abortController` + boot reconciliation, **not** the existing `pgrep` sweep.

### 9.3 Config snippets

**claude-sdk subscription profile (R1+R2+R3):**

```json
{
  "backends": {
    "claude-sdk-opus": {
      "kind": "claude-sdk",
      "model": "claude-opus-4-8",
      "auth": { "kind": "subscription" },
      "costMode": "included",
      "params": { "effort": "high", "thinking": { "type": "adaptive", "display": "summarized" } }
    }
  },
  "defaults": { "orchestrator": { "backend": "claude-opus" }, "worker": { "backend": "claude-opus" } }
}
```

`defaults` stays on the PTY `claude-opus` profile until the user opts in (no `features` flag). `display:"summarized"` required for streamed thinking on Opus 4.7+ (passed through `params`; spike-verify the TS surface accepts it).

**Future DeepSeek profile (R4 — Lane B, config-only once §8.3 exists):**

```json
{
  "backends": {
    "deepseek-r1": {
      "kind": "openai", "model": "deepseek-reasoner",
      "baseUrl": "https://api.deepseek.com",
      "auth": { "kind": "env", "ref": "DEEPSEEK_API_KEY" },
      "pricing": "deepseek:reasoner", "costMode": "billed",
      "params": { "reasoningField": "reasoning_content" }
    }
  },
  "prices": { "deepseek:reasoner": { "in": 0.55, "out": 2.19, "cacheRead": 0.14, "cacheCreate": 0.55, "cacheCreate1h": 0.55 } }
}
```

Kimi identical: `baseUrl:"https://api.moonshot.ai/v1"`, `model:"kimi-k2-thinking"`, `auth.ref:"MOONSHOT_API_KEY"`.

---

## 10. Phased migration plan

**No "Phase 0 flip."** Each phase is behind profile selection; revert = reset the profile. No phase mutates the PTY contract. Each phase is gated by `eos build --check` (lint + all suites). New backend/infra/contract TS makes the daemon stale (the `*.md`/`scripts/hooks/` build exclusions don't apply here).

| Phase | Scope | Verify | Rollback |
|---|---|---|---|
| **1 — Contract + transport + UI plumbing + wiring check** | Add `DeltaEventSchema` (with synthesized `blockId`); add `streamingThinking?`/`resumable?` caps; `onAgentEvent` `delta` sink branch (publish `agent:delta`, no persist/reduce); `agent:delta` SSE relay; **`agent_event`→blocks decoder in `buildBlocks` (§6.4)**; `thinkingStore.js` + `useLive` branch + **new live thinking renderer (§6.5)**. **Verify §5.5:** confirm with file evidence that `onAgentEvent` drives `reduceAgentSignal` for an `inproc` backend today; if not, wire it. | `contracts`/`core`/`app/ui` suites; unit: synthetic `delta` publishes `agent:delta` and never appends a row; `thinkingStore` accumulates + finalizes by `blockId`; **decoder test: a persisted `agent_event` message renders thinking/text/tool blocks**; **reload test: finished SDK turn survives refetch with no live buffer.** PTY emits no deltas → unaffected. | Revert additive schema/topic/decoder; nothing consumes them yet. |
| **2 — `AuthResolver` + BillingGuard + PTY env audit** | New `AuthResolver` port + `SubscriptionAuthResolver` (long-lived **setup-token**, §4.3); `billing-env.ts` (env **replacement** semantics). Fix `backendProfile:null` persistence. **Audit PTY child env (§4.5).** Profile-keyed `priceFor` + `costMode` label. | Unit: subscription/env/keychain resolution; env helper strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, injects OAuth, never logs token; **PTY env audit result documented.** | Delete new files; revert pricing change. |
| **3 — `ClaudeSdkBackend` vs FAKE SDK + the HARD billing/parity spike** | Install `@anthropic-ai/claude-agent-sdk` (pin exactly; test direct-Anthropic re #337). Build `ClaudeSdkBackend` + `SdkEventMapper` + `SdkToolHost` (capturing shim or refactor, §7.1) + per-spec session factory (§7.3) + `SdkPermissionBridge`. `FakeSdkQuery` replays scripted `SDKMessage` → assert exact canonical sequence (session/turn/delta×N/message/usage) **without billing**. **Then the spike — must prove ALL:** (a) `includePartialMessages` emits `thinking_delta`/`text_delta` + measure cadence; (b) **`options.env` replaces vs overlays the child env**; (c) a daemon-level `ANTHROPIC_API_KEY` does **not** reach the child under `billing-env.ts`; (d) the **actual** auth-source signal (token prefix `oat01` and/or out-of-band probe — **no invented field**); (e) subscription billing on a throwaway daemon (`EOS_HOME=$(mktemp -d)`, one real turn); (f) `ENABLE_TOOL_SEARCH=false` direct load (or settings fallback); (g) `canUseTool` parity + whether it surfaces a subagent id; (h) `query.setModel`/`setPermissionMode` (decides runtime-switch caps). Register behind transient `EOS_ENABLE_SDK_BACKEND`. **Re-verify the billing pause + ToS posture.** | `FakeSdkQuery` canonical-sequence test; `SdkPermissionBridge`→`PolicyGatewayService` parity test; per-spec identity test (two concurrent fake workers don't cross-wire); spike checklist (a)–(h) all green. | Unset `EOS_ENABLE_SDK_BACKEND`; uninstall dep (kind degrades to PTY at spawn). |
| **4 — Capability-gated UI audit** | Audit every keystroke/`/model`/`/permissions`/rewind affordance to read `worker.capabilities` (hide for SDK: `keystroke:false`, runtime-switch `false` initially). | `app/ui` vitest: gated controls hidden for SDK caps; live thinking renders; whole block persists on reload. | Inert without SDK workers. |
| **5 — Register + canary** | Register `claude-sdk` unconditionally (drop `EOS_ENABLE_SDK_BACKEND`); make `DispatchMessage.attach` backend-aware (close verified no-fallback gap); selection-time PTY fallback on creds-absent (§4.6). Canary: ONE orchestrator via explicit `claude-sdk-opus`; `defaults` stay PTY. | E2E on canary: spawn → real-time thinking → gated tool call → `ask_user` round-trip → interrupt (cancels long-poll, §7.7) → stop. A PTY worker in the same daemon behaves identically. | Reset canary profile to `claude-cli` (per-worker). |
| **6 — Resume + boot reconcile + runtime caps** | Backend-aware resume via `session_id` (gate on `resumable`); boot reconciler (resume vs SUSPENDED vs stale). If spike (3h) verified `setModel`/`setPermissionMode`, flip those caps `true` + unhide UI. | Restart daemon with live SDK orchestrator → resumes; Lane-B → stale; PTY resume unchanged. | Resume stays PTY-only; caps stay `false`. |
| **7 — Default cutover (opt-in)** | User flips `defaults.*.backend` to `claude-sdk-opus`. **Gate:** only after Phase 3 proved an assertable auth-source signal (§4.6) — else keep defaults on PTY. Creds-absent auto-falls-back. **Re-verify pause + ToS.** | Soak: fresh + resumed sessions, multi-tool orchestrator runs, day-long `ask_user`, subscription billing holds, cost shows "included", per-worker identity correct under concurrency. | One-line config revert to PTY default; running workers keep persisted `backend_kind`. |
| **8 — Lane B (multi-provider), separate track** | `ModelClient.streamTurn?`; `OpenAiCompatibleModelClient` (arg-fragment buffering + cross-turn `reasoning_content` echo); thread `backendOptions`; per-spawn `InProcessEnvFactory`; DeepSeek/Kimi profiles. | DeepSeek worker streams reasoning through the **same** `delta` pipeline; gated tools; second matching-ACL provider is config-only. | Remove profiles; Lanes A/PTY unaffected. |

### Dependency-ordered checklist

1. `DeltaEventSchema` + caps (contracts/core) → 2. `agent:delta` sink + SSE relay (manager) → 3. **`buildBlocks` `agent_event` decoder + live renderer + `thinkingStore`** (app/ui) → 4. §5.5 reducer-wiring verification → 5. `AuthResolver` + `billing-env` + PTY env audit → 6. `backendProfile` persistence fix → 7. tool-module adaptation (refactor or capturing shim) + **per-spec session factory** → 8. `SdkEventMapper` + `SdkPermissionBridge` + `ClaudeSdkBackend` → 9. `FakeSdkQuery` tests → 10. **the spike (hard gate)** → 11. capability-gated UI audit → 12. register + `attach` fallback + canary → 13. resume + boot reconcile → 14. default cutover (gated) → 15. (separate) Lane B.

---

## 11. Risks & mitigations

| Risk | Likelihood / Impact | Mitigation |
|---|---|---|
| **`options.env` overlays (not replaces) the child env → leaked `ANTHROPIC_API_KEY` bills API silently** | Med / **Critical** | Spike (3b/3c) proves replace-vs-overlay; if overlay, construct a complete explicit env; assert no API key in child. |
| **No assertable runtime auth-source signal exists** | Med / **Critical** | Do not depend on an invented field. Minimum guard = pre-launch invariant (`oat01` token + no API key in child). Spike (3d) seeks a real signal; if none, keep `defaults` on PTY (Phase 7 gate). |
| **Cached `~/.claude` token goes stale once interactive `claude` stops** | High if PTY replaced / High | Use long-lived `setup-token` (`oat01`), not `readOauthToken()`'s cached token; spike verifies refresh. |
| **PTY fallback itself may already bill API (`claude-args.ts` inherits `ANTHROPIC_API_KEY`)** | Med / High | Phase-2 PTY env audit; scrub PTY child env if needed (may break "zero edits to PTY" — maintainer decision §12). |
| **Anthropic ToS / active blocking of subscription-bridging harnesses** | Low–Med / **Critical** (kills SDK path) | Distinct risk row; PTY is the *sanctioned* path; spike checks for differential rate-limit/block; keep PTY first-class indefinitely. |
| **June-15 credit-pool split un-pauses** | Med / High | PTY fallback; `costMode` first-class; re-verify pause at Phases 3 & 7; config flip not rewrite. `costMode` is a **label, not a guardrail** — add a spawn-time warning when an `included` profile is selected but live policy indicates the split is active. |
| **`blockId` collisions (SDK index resets per message)** | High if unaddressed / High | Synthesize `${uuid}:${index}`; stamp identical id on durable block; collision-freedom test (§6.2). |
| **SDK message has no durable render path (`buildBlocks` jsonl-only)** | Certain if unaddressed / **Critical** (thinking vanishes) | Phase-1 `agent_event` decoder + reload test (§6.4). |
| **`McpToolModule` exposes no schema/handler → SdkToolHost won't compile** | Certain if unaddressed / High | Refactor to data contract OR capturing fake-`McpServer` shim; booked as real work (§7.1). |
| **Per-worker identity is process-global → concurrent in-process workers cross-wire** | Certain if unaddressed / **Critical** | Per-spec session factory; no `process.env` at call time; concurrency test (§7.3). |
| **`input_json_delta` on the thinking channel → garbage live deltas / broken ordering** | High if unaddressed / Med | Mapper enumerates handled subtypes; drops `input_json_delta`/`signature_delta`/`citations_delta` (§6.7). |
| **`reduceAgentSignal` not actually wired for inproc → no state heal/settle for SDK** | Unknown / High | §5.5 verification task in Phase 1; reinstate wiring if absent. |
| **Long-poll tools leak forever-timers in-process on interrupt** | High if unaddressed / Med | Thread SDK `AbortSignal` into `ask_user`/`ask_peer`/`respond_to_peer` (§7.7). |
| **`#337` empty-thinking opens an empty live line** | Low (direct-Anthropic safe) / Low | Lazy-open on first non-empty `thinking_delta`; pin SDK version (§6.6). |
| **`agentId` not surfaced in `canUseTool`** | Unknown / Med | Daemon-level spawning (no SDK `agents:{}`); fail-closed on missing id; spike (3g). |
| **`ENABLE_TOOL_SEARCH=false` not honored by TS SDK** | Med / Low | Plan B = `settings.toolSearchEnabled:false` (proven PTY mechanism) (§7.2). |
| **`thinking.display`/effort param surface unconfirmed in TS** | Med / Low | Pass via `params`/`options.env` passthrough; probe `supportsEffort`; integration-verify (non-blocking for R2 core). |
| **Live↔durable double-render flash** | Med / Low | `blockId` handoff frame defined; live unmounts exactly when durable block appears (§6.5). |
| **R4 "zero pipeline code" overstated** | Certain / Low (scoping) | Documented: first OpenAI-compat provider is real ACL work; only matching-ACL second is config-only (§8.2). |

---

## 12. Open questions / maintainer decisions

1. **PTY env hygiene vs "zero edits to PTY."** If the Phase-2 audit shows the daemon can carry `ANTHROPIC_API_KEY` while subscription PTY workers run, the *only* true R3 guarantee requires scrubbing the PTY child env too — breaking the "zero edits to PTY" invariant. **Decision:** accept a minimal PTY env-scrub, or guarantee the daemon never carries `ANTHROPIC_API_KEY` operationally?
2. **OAuth token source & lifecycle.** Commit to the long-lived `setup-token` (`oat01`) as the single source for the SDK lane (recommended), and define the operator UX when it expires (~1yr) — a worker-level "auth expired" error surfacing a `claude setup-token` re-run?
3. **ToS posture.** Given Anthropic's "use API key" stance and reports of active blocking of subscription-bridging harnesses, is SDK-on-subscription an acceptable product risk, or should the SDK lane default to API-key billing (`costMode:"billed"`) with subscription as an explicit user opt-in, keeping PTY as the only *sanctioned* subscription path?
4. **Tool-module adaptation strategy (§7.1).** Refactor `McpToolModule` to a data contract (cleaner, larger blast radius) **or** the capturing fake-`McpServer` shim (smaller, some duplication of the description Proxy)?
5. **`reportsMessageEvents` for SDK.** Confirmed `false` here (in-process ordering is naturally correct; `DispatchMessage` appends at dispatch). Confirm the spike sees the user turn echoed in-stream deterministically, or accept dispatch-time append unconditionally.
6. **Runtime model/permission switch caps.** Ship `false` first (LSP honesty); flip to `true` only if the spike verifies `query.setModel`/`setPermissionMode`. Acceptable to ship GA with these `false`?
7. **Rewind on SDK workers.** No SDK equivalent for the TUI rewind choreography. Accept a capability gap (hidden affordance), or invest in an SDK conversation-history reimplementation later?
8. **Auth-source assertion failure handling.** If no post-launch signal is obtainable, the safe path is keeping `defaults` on PTY indefinitely. Is the pre-launch invariant (`oat01` + no API key in child) a sufficient guard to greenlight cutover without a post-launch signal?
9. **Lane B timing.** Build Lane B (DeepSeek/Kimi) on the hand-rolled `OpenAiCompatibleModelClient` + `streamTurn?` (preserves the lint-enforced ports), or adopt the Vercel AI SDK and retire `ModelClient` wholesale?

---

**Bottom line.** The migration is overwhelmingly *adapters into an existing, canonical spine* — **one additive contract event, one new port, two optional capability booleans, zero new migrations, zero edits to the PTY happy-path** — but four verified blockers reshape the build and **must** be in the plan body, not deferred: (1) the SDK is a **subprocess driver**, so billing safety means **proving the child env is controlled**; (2) `blockId` must be **synthesized** (`uuid:index`); (3) a **new `agent_event` render decoder** is mandatory or SDK output vanishes; (4) tool **identity must become per-worker** and the **`McpToolModule` interface must be adapted** before any in-process tool can compile. A hard **Phase-3 spike** gates the default cutover on empirically resolving the env-replacement, an assertable auth-source signal, and a single coherent token lifecycle. **PTY remains the first-class, sanctioned subscription fallback throughout** — and may, on the ToS finding, remain so indefinitely.
