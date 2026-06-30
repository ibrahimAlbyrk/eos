# Multi-Provider API Backend Lane — Implementation Plan

> The crown synthesis of findings 01–06. Every load-bearing claim below was
> spot-verified against the code on `feat/multi-provider-api` (cites are
> `file:line`). Where two findings conflicted, the conflict is reconciled in the
> text, not papered over (see §3, §6). This is a plan only — no code is changed
> by this document; the file-by-file change map is §11.

---

## 1. Executive summary

**Thesis.** The in-process metered API lane is **not a greenfield build — it is wired into production and structurally conformant**: `InProcessBackend` (`infra/src/backends/InProcessBackend.ts`) drives the existing Eos-hosted agentic loop `ToolRuntime.runTurn` (`core/src/use-cases/ToolRuntime.ts:37`) over real `AnthropicModelClient` / `OpenAIModelClient` transports, gated by the same policy engine as the SDK/CLI lanes, registered for `anthropic-api`/`openai`/`codex` in `manager/container.ts:758-777` and `:867-872`. The architectural seam is sound: descriptor-driven, capability-gated, registry-pluggable. **But "structurally conformant" is not "production-ready":** the conformance suite (`infra/src/__tests__/agent-backend-conformance.ts`) runs a *fake* `ModelClient` with scripted turns and an always-allow gate — it proves the adapter *shape* (5 universal invariants), and exercises **no system prompt, no real model, and no real tools**. It is zero evidence the lane runs an actual worker. Read the green suite as "the seam is right," never as "the lane works end-to-end."

So the work is **"instruct + feed + configure + persist + harden,"** not "design from scratch." **Six** concrete gaps stand between today and the four user goals — the first is a **BLOCKER**:

0. **No instructions (system prompt / DPI) — the BLOCKER.** The in-process model clients are built with **no `system` field** (`container.ts:761,771`) and `InProcessBackend.start` pushes only the user task as a `user` message (`:140`); `assembleAppendFor` (the DPI + injected-memory assembler) is invoked **only** by the SDK/CLI lanes (`:804`). So an API worker today gets its *tools* but **no role framing, no reporting contract, no worker-definition body/persona, and no injected CLAUDE.md memory** — the exact failure the SDK lane documents: an agent that "has the MCP tools but ignores them" (`ClaudeSdkBackend.ts:73-77`). This defeats G2/G3/G4, and the skills design (§5c) rests on a prompt slot the plan must first create. Fixed in **§5h**, landed in **M1** before any worker-instruction-parity or skills milestone.
1. **Tool-starved** — the lane offers the model *only* Eos control tools (`mcp__worker__*`/`mcp__orchestrator__*`); the ~16 built-ins (Read/Write/Edit/Bash/Glob/Grep/…) do not exist anywhere in the repo (`buildLaneTooling`, `container.ts:743-754`).
2. **Not per-worker configurable** — a profile's `baseUrl`/`auth`/`params` are dropped before the adapter; the factories read global `process.env` (`container.ts:761,771`), so "any provider by key/localhost, per worker" is not expressible.
3. **Not durable** — in-process sessions live only in an in-memory `Map`; `sessionStore:"none"`, no `session:"ready"`+`sessionId` is ever emitted (`InProcessBackend.ts:139`), so a daemon restart kills every API worker.
4. **Feature-thin** — external MCP, Agent Skills, and prompt-template slash-commands are unwired (skills have *no* loader at all); only Eos control commands (`/clear`) work.
5. **Correctness/robustness holes** — the policy `updatedInput`/rewrite path is silently dropped on the API gate (`PolicyToolGate.ts:16`); the cross-provider **reasoning round-trip rule is opposite** across providers (DeepSeek 400s if you echo reasoning back, Anthropic 400s if you don't); unknown models bill at **Opus rates** (`container.ts:242`); there is **no retry/backoff** (a single 429 kills the turn) and **no context compaction** (small-context localhost models 400 within a few tool turns).

**Headline approach.** Close every gap *behind the existing capability seam*, never by branching on a backend `kind` literal. **The foundation is instructions:** deliver a *complete* DPI-assembled system prompt to the in-process model via `assembleAppendFor(spec, id, "in-process")` → the model client's existing `system` field (§5h). A new provider becomes **one `BackendProfile` config entry + (optionally) one `ProviderCapabilities` block — no new class** (two wire dialects, Anthropic Messages + OpenAI Chat Completions, cover the entire ecosystem incl. Ollama/vLLM/LM Studio/DeepSeek/GLM/OpenRouter/LiteLLM). Built-ins become a `BuiltinToolRegistry` of standalone bare-named `RuntimeTool`s merged into the loop. Durability becomes a `ConversationStore` port. Per-worker config becomes a thread of references (never secrets) from resolver → spec → an async env factory that resolves credentials at `start()`. Robustness (retry/backoff, context compaction, accurate pricing, observability) is capability-gated shared infra. The result satisfies SOLID by construction: extension is data + registry entries, not edits to consumers.

---

## 2. Goals & non-goals

### 2.1 User goals as acceptance criteria

| # | Goal | Acceptance (verifiable) | Delivered by |
|---|------|------------------------|--------------|
| **G1** | An API lane connecting **any** provider — by API key (OpenAI, DeepSeek, GLM, Anthropic, …) **and** local models by localhost base URL. | A worker spawned on a `glm-local` profile (`kind:"openai"`, `baseUrl:"http://localhost:11434"` (origin-only, §7.1/MJ1), `auth:{kind:"none"}`) reaches *that* endpoint with *that* (absent) key and completes a gated turn; a `deepseek` profile reaches `api.deepseek.com` with its keychain key. Verified by an integration test asserting the **exact composed URL** (`<origin>/v1/chat/completions`) + auth the model client receives. | M1 |
| **G2** | The "empty" API agent gains the **full** SDK/CLI feature set — all built-in tools (write/bash/read/edit/glob/grep/…), MCP, skills, everything. | An API worker calls `Write`/`Edit`/`Bash`/`Grep` with identical semantics to the SDK lane (line-numbered `Read`, unique-`old_string` `Edit`, ripgrep `Grep`); external MCP tools and skills are callable. Verified by a cross-lane tool-behavior conformance suite + MCP/skill integration tests. | M2, M5, M6 |
| **G3** | **Any** model assignable to the orchestrator, built-in workers, **and** all project/user-scope workers (e.g. set worker X to GLM-5.2 or DeepSeek V3) — all interoperating seamlessly and in sync. | A built-in/project/user `.md` worker definition declaring `backendProfile: glm-local` spawns on GLM; the orchestrator on `deepseek` spawns a Claude-subscription child that spawns a GLM grandchild, all reporting through the same canonical event stream; assignment **survives a daemon restart**. Verified by a multi-scope spawn test + a restart test. | M1, M3 |
| **G4** | Fully **modular, configurable, customizable, clean, SOLID.** | Adding provider "X" requires *zero* new classes — one `config.backends["x"]` entry (+ optional `capabilities`). Adding a built-in tool = one registry entry. Adding a slash-command = one registry entry. No consumer reads a backend `kind` literal (`backend-kind-literal-guard` stays green). | All milestones; §4.6 |

### 2.2 Non-goals (explicit out-of-scope for this effort)

- **Native OpenAI Responses API.** We target Chat Completions only — it is the portable lingua franca; Responses is OpenAI-proprietary and unimplemented by the compatible ecosystem (06 §1.4). Not a transport we add.
- **A third wire dialect** (e.g. native Ollama `/api/chat`). The `/v1/chat/completions` path covers Ollama; defer a third adapter unless `/v1` proves too lossy (06 §3.2).
- **Prompt-injected tool calling for models with no native function calling** (`supportsTools:false`, the YAML-template path). Capability-gated, deferred to a later cut (06 §3.4).
- **Live backend switching onto the API lane.** Cross-lane handoff needs a shared `sessionStore` (`canHandoffBackend`, `core/src/domain/backend-switch.ts:21-31`); the metered lane has none. Provider assignment is **spawn-time** (and inheritance-time), not a live `PUT /workers/:id/backend` move. Stated as a supported-path constraint, not a gap to close.
- **Auto-trigger skill fidelity** matching the binary's heuristics. v1 ships discovery + metadata injection + manual `Skill` invocation; auto-trigger is a refinement (03 §4.2).
- **Runtime capability *probing*.** Capabilities are *declared* in config (the LiteLLM model-map pattern), not discovered by handshake (06 §5.5).
- **Changing the claude-cli / claude-sdk lanes' behavior.** They are the reference; we touch shared contracts they consume (e.g. `ToolGate`) only in backwards-compatible ways.

---

## 3. Current-state synthesis (consolidated truth across all six dimensions)

### 3.1 What exists / stubbed / missing

Legend: **EXISTS** = built & working · **STUBBED/DISABLED** = present but off or no-op · **MISSING** = no code.

| Area | State | Evidence (verified) |
|------|-------|---------------------|
| `AgentBackend`/`AgentSession`/`AgentBackendRegistry` seam (capability-driven) | **EXISTS** | `core/src/ports/AgentBackend.ts:63-198`; consumers branch on `descriptor.*`/`capabilities.*` |
| `ToolRuntime.runTurn` agentic loop (model→gate→exec→feed-back, streaming, abort, max-iters, fail-closed) | **EXISTS, reusable as-is** | `core/src/use-cases/ToolRuntime.ts:37-131` |
| `InProcessBackend` adapter (drives `runTurn`, in-memory live registry) | **EXISTS — shape-conformant only** (fake model, scripted turns; not lifecycle/tools/prompt) | `infra/src/backends/InProcessBackend.ts`; conformance `infra/src/__tests__/agent-backend-conformance.ts` (5 universal invariants, fake `ModelClient`) |
| Production wiring of anthropic-api/openai/codex over real model clients + policy gate | **EXISTS** | `container.ts:758-777`, registry `:867-872` |
| **System prompt / DPI delivery on the in-process lane** | **MISSING — BLOCKER (B1)** | factories pass no `system` (`container.ts:761,771`); `start` pushes only the task (`InProcessBackend.ts:140`); `assembleAppendFor` wired to SDK/CLI only (`:804`) |
| Model clients accept a `system` field (the delivery *target* exists) | **EXISTS** | `AnthropicModelClient.ts:23,37`; `OpenAIModelClient.ts:22,37` |
| `assembleAppendFor` (DPI text + injected memory; memory-injection keyed on lane) | **EXISTS** | `container.ts:668-675`; `assembleAppendText` `:601-663`; `selectInjectableMemory` drops sources native to the lane |
| `AnthropicModelClient` (Messages API, `createTurn`) | **EXISTS** | `infra/src/backends/AnthropicModelClient.ts:29-107` |
| `OpenAIModelClient` (Chat Completions, `createTurn` **+** `streamTurn`, `baseUrl` swap, `reasoning_content`) | **EXISTS** | `infra/src/backends/OpenAIModelClient.ts:27-206` |
| `BackendProfile` config model (`kind,model,baseUrl?,auth?,pricing?,costMode?,params?`) | **EXISTS** | `contracts/src/backend.ts:25-37` |
| 4-tier backend resolver (profile → parent-inherit → role default → claude-cli) | **EXISTS** | `core/src/services/SqlBackedBackendResolver.ts:35-65` |
| Shared policy engine, bare-name keyed, zero backend branching | **EXISTS** | `core/src/services/PolicyGatewayService.ts`; `classifyTool` `core/src/domain/permission-mode.ts:56-73` |
| `/clear` control slash-command (backend-agnostic, capability-gated) | **EXISTS, works on API lane** | `core/src/domain/commands/clear.ts`; `InProcessBackend` `contextClear:true` |
| MCP **resolution policy** + discovery (lane-neutral) | **EXISTS** | `core/src/domain/mcp-resolution.ts:66-81`; `infra/src/mcp/FileMcpServerCatalog.ts` |
| All three in-process descriptors `enabled:false` | **DISABLED** | `InProcessBackend.ts:55-57` |
| `streamingThinking` capability on the API lane | **STUBBED** (loop emits deltas; `CAPS` omits flag) | `InProcessBackend.ts:44-51` vs `ToolRuntime.ts:56-60` |
| `AnthropicModelClient.streamTurn` (live thinking) | **MISSING** | `AnthropicModelClient.ts:33-61` (createTurn only) |
| `setModel` on the API lane | **STUBBED** (hard no-op, `runtimeModelSwitch:false`) | `InProcessBackend.ts:113` |
| `clearContext` emitting `session:"cleared"` | **STUBBED** (drops buffer, emits no event) | `InProcessBackend.ts:104-110` |
| The ~16 built-in tools (Read/Write/Edit/Bash/Glob/Grep/…) | **MISSING** (zero implementations repo-wide) | `buildLaneTooling` projects only control defs, `container.ts:743-754` |
| Per-worker `baseUrl`/`auth`/`params` threading | **MISSING** (dropped; factories read `process.env`) | `spawn-worker.ts:122-123`; `container.ts:761,771,278` |
| `ResolvedBackend.auth` field | **MISSING** | `core/src/ports/BackendDefaults.ts:8-16` — **see §3.2 reconciliation** |
| `BackendLaunchOptions.baseUrl` | **MISSING** (`auth?`/`params?` exist) | `AgentBackend.ts:104-110` |
| `WorkerDefinition.backendProfile` field | **MISSING** | `contracts/src/worker-definition.ts:11-44` |
| `AuthRef.kind:"none"` (keyless localhost) | **MISSING** (enum is subscription/env/keychain) | `contracts/src/backend.ts:17-23` |
| Conversation persistence / `ConversationStore` port / restart resume | **MISSING** | no port; `InProcessBackend.ts:9-10` notes the gap; reconcile closes rows without `session_id` (`ReconcileWorkersOnBoot.ts:38`) |
| `updatedInput`/rewrite propagation on the API gate | **MISSING** (silently dropped) | `PolicyToolGate.ts:16`; `ToolGate.decide` return `ToolRuntime.ts:21-24` |
| Orchestrator-`Task` surface stripping on the API lane | **MISSING** (no `--disallowedTools` analogue) | `tool-scope.ts:52,57-61` only applied to CLI/SDK |
| External MCP **client** + RuntimeTool projection on the API lane | **MISSING** | `buildLaneTooling` never calls `resolveMcpServers`; no embedded client |
| Skills loader/invoker (any) | **MISSING** (discovery-only via `/commands`) | `commands.ts:67-106` lists; no body load/inject |
| Prompt-template `.md` command expander | **MISSING** (binary expands today) | `commands.ts` discovery only |
| Non-Claude model catalog + price/effort sources | **MISSING/Claude-only** | `ModelCatalogService.ts:55-59`; `container.ts:233-244` |
| `OpenAIModelClient` reading `cached_tokens`; Anthropic `cache_control` injection | **MISSING** (caching off / inaccurate) | `OpenAIModelClient.ts:129`; `AnthropicModelClient.ts:64-76` |
| Per-model pricing for non-Claude models | **DEFECT — falls through to Opus rates** | `priceFor` substring-matches Claude, else `return config.prices.opus` (`container.ts:242`) |
| `baseUrl` path convention (client always appends `/v1/...`) | **DEFECT — undefined + plan example wrong** | `${base}/v1/chat/completions` (`OpenAIModelClient.ts:41,67`), `${base}/v1/messages` (`AnthropicModelClient.ts:43`) |
| Transport retry / backoff / `Retry-After` (429/5xx) | **MISSING** (single `fetch`; `!resp.ok`→turn ends) | `OpenAIModelClient.ts:49-51`; `AnthropicModelClient.ts:55-58`; `ToolRuntime.ts:83-86` |
| Context-window management / compaction; `contextWindow` consumer | **MISSING** (history grows unbounded) | `ToolRuntime.ts:93,99`; `InProcessBackend.ts:80` accumulates; nothing reads `contextWindow` |
| `Task` subagent execution on the API lane | **MISSING** (`RuntimeTool.execute` has only `input` — no env/model/gate/emit) | `ToolRuntime.ts:16-19` |
| `IdGenerator.newSessionId` (durability sessionId source) | **MISSING** (no session method) | `core/src/ports/IdGenerator.ts`; `RandomIdGenerator.ts:9-15` |

### 3.2 Reconciling the one cross-finding conflict (dim 01 vs dim 04)

Dim 01 §3.2 stated the resolver "computes `ResolvedBackend.baseUrl`/`auth`/`params`." Dim 04 §5 corrected this. **Verified: dim 04 is correct.** `ResolvedBackend` has **no `auth` field** (`BackendDefaults.ts:8-16`: only `kind,model,profileName,baseUrl?,pricing?,costMode?,params?`), and the profile's `AuthRef` is dropped one hop earlier than dim 01 implied — at `backendDefaults.profile()`, which maps `kind,model,profileName,baseUrl,pricing,costMode,params` but **not `p.auth`** (`container.ts:278`). Consequence for the design: the fix must **add `auth` to `ResolvedBackend`** *and* map it at `profile()`, not merely thread an existing field (§5a). `baseUrl`/`params` are present on `ResolvedBackend` but dropped later at `spawn-worker.ts:122-123`; `auth` is dropped at the very first hop.

All other inter-finding claims were internally consistent and verified (e.g. dim 05's "the `updatedInput` fix is 2 edits, no `PolicyDecider` change" is confirmed: `sdkPolicy` already returns `updatedInput`, `container.ts:731`).

---

## 4. Target architecture (end state)

### 4.1 Component diagram

```
                          ┌─────────────────────────────────────────────────────────┐
                          │  contracts/  (Zod SSOT — single source of truth)          │
                          │  BackendProfile{kind,model,baseUrl,auth,params,           │
                          │     capabilities?}  ·  AuthRef{none|env|keychain|sub}     │
                          │  WorkerDefinition{…, backendProfile}  ·  ProviderCaps      │
                          │  ToolGate.decide → {allow,message?,updatedInput?}          │
                          └───────────────▲───────────────────────────▲──────────────┘
                                          │ types                      │ types
   ┌──────────────────────────────────────┴─────────┐    ┌────────────┴────────────────────────┐
   │  core/  (pure domain · ports · use-cases)        │    │  selection / resolution               │
   │  ┌────────────────────────────────────────────┐ │    │  SqlBackedBackendResolver             │
   │  │ ToolRuntime.runTurn  (the agentic loop)     │ │    │   1 profile→2 inherit→3 role→4 cli    │
   │  │  model→gate→exec→feed-back→repeat (≤50)     │ │    │  resolveSpawnBackend + spawnBackendErr│
   │  │  one fail-closed chokepoint executeGated    │ │    └───────────────────────────────────────┘
   │  └───────▲────────────▲─────────────▲──────────┘ │
   │  ports:  │ ModelClient │ ToolGate    │ tools Map   │    NEW ports (this plan):
   │          │             │             │             │    ConversationStore · BuiltinToolRegistry
   │  BuiltinToolRegistry · ConversationStore · FileSystem · ProcessRunner · SkillCatalog · McpToolClient
   └──────────┼─────────────┼─────────────┼─────────────┘
              │             │             │
   ┌──────────┼─────────────┼─────────────┼──────────────────────────────────────────────────────┐
   │  infra/  (Node adapters)                                                                       │
   │  AnthropicModelClient   OpenAIModelClient        BuiltinTools (bare-named RuntimeTools):       │
   │   (Messages, +streamTurn) (Chat Completions, baseUrl)  Read/Write/Edit/MultiEdit/NotebookEdit/ │
   │        │  wire dialect = "anthropic"   "openai-chat"   Bash/BashOutput/KillShell/Glob/Grep/LS/ │
   │        └──── ProviderCapabilities drives quirks ────►  WebFetch/WebSearch/TodoWrite/Task/      │
   │  JsonlConversationStore   RuntimeMcpClient   FileSkillCatalog   ExitPlanMode                    │
   └────────────────────────────────────▲──────────────────────────────────────────────────────────┘
                                         │ implements ports
   ┌─────────────────────────────────────┴──────────────────────────────────────────────────────────┐
   │  manager/  (composition root + entrypoints)                                                       │
   │  container.ts: InProcessBackend(kind, asyncEnvFactory, { store, ids })  // store/ids for durability│
   │    asyncEnvFactory(spec): resolve auth/baseUrl/params via AuthResolver →                          │
   │      system = assembleAppendFor(spec.backendOptions.spec, id, "in-process")   // ◀ B1: DPI prompt  │
   │      buildLaneTooling(spec) = control tools (prefixed) ⊕ built-ins (bare, disallow-stripped)      │
   │                              ⊕ external-MCP RuntimeTools ⊕ Skill RuntimeTool                       │
   │    → {model: dialectClient(creds, caps, tools, system), tools, gate: makePolicyToolGate(...)}     │
   │  onAgentEvent → processAgentSignal (FSM, cost ledger, SSE) ; store.save in kickTurn .then         │
   │  routes: POST /api/backends (add provider; normalize baseUrl, require price) · GET /api/ui-config │
   └───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 The provider/model abstraction — `BackendProfile`-centric, two dialects + native escape hatch

The reframing that makes all four goals tractable (04 §4, corroborated by 06 §3.2): **on `modelSource:"profile"` lanes, a `BackendProfile` IS the unit of model selection** — it bundles `{kind(=dialect), model, baseUrl, auth, params/capabilities}`. "Assign GLM-5.2 over my localhost key to worker X" ≡ "assign the `glm-local` profile to worker X." This reuses the existing resolver precedence, role defaults, and `descriptor.modelSource` split.

- **Exactly two wire dialects** cover the whole ecosystem (06 §1.3, §3.2): Anthropic Messages (`AnthropicModelClient`) and OpenAI Chat Completions (`OpenAIModelClient`, `baseUrl`-swappable). Local models (Ollama/vLLM/LM Studio) and proxies (LiteLLM/OpenRouter) and hosted (DeepSeek/GLM) all speak Chat Completions → reached by pointing `baseUrl` at them. **No new transport class per provider.**
- **A typed `ProviderCapabilities`** (new, in `contracts/`) carries every per-provider quirk as *declared data* (06 §3.4): `wire`, `supportsStreaming`, `supportsTools`, `reasoning`, `reasoningRoundTrip`, `cache`, `cacheMinTokens`, `structuredOutput`, `contextWindow`, `maxTokens`. Adapters read declared facts, never `if (model.startsWith("deepseek"))`. This is the same idea Eos already uses for `AgentCapabilities`/`BackendDescriptor`, extended to the API lane — and it is what keeps G4 (SOLID) true.
- **A native escape hatch** `ModelTurn.providerMetadata?: Record<string,unknown>` (new) lets adapters stash the native stop reason / signed thinking blocks / cache fields without bloating the neutral contract (06 §2). This is the structural reason Eos keeps `ModelTurn` neutral rather than passing OpenAI's envelope through — the OpenAI shape cannot hold Anthropic's signed thinking blocks (06 §3.1).

### 4.3 The tool harness — `BuiltinToolRegistry` → `ToolRuntime`

The loop is settled (`ToolRuntime.runTurn` exists). What's missing is the `tools: Map<string,RuntimeTool>` it dispatches and the matching model schema. Design (02 §4.2, Option B — recommended):

- **Standalone bare-named `RuntimeTool`s in `infra/src/tools/builtins/`**, one per tool, depending on `FileSystem`/`ProcessRunner` ports (DIP, unit-testable without disk). **Bare canonical names** (`Bash`, `Write`, `Read`, …) and **canonical input fields** (`command`, `file_path`, `pattern`, …) so the entire policy/permission-mode/editRegex stack applies unchanged (05 §4.1 — the single binding requirement; a wrong name is a *silent* capability escape).
- **A `BuiltinToolRegistry`** (new port + infra registry) mirroring the existing Open/Closed registries (`AgentBackendRegistry`, the slash-command registry): adding a tool = one entry, no dispatch edits.
- **`buildLaneTooling` becomes the single merge point** (already proven for control tools, `container.ts:743-754`): it merges into `items` (model schema) + `tools` (dispatch map) four sources — control tools (prefixed, daemon-loopback ctx) ⊕ built-ins (bare, `cwd`-scoped) ⊕ external-MCP RuntimeTools (§4.4) ⊕ the `Skill` RuntimeTool (§4.4). Orchestrator `Task` is stripped here via `disallowedBuiltinToolsFor(spec.isOrchestrator)` (05 §3.2).

### 4.4 MCP / skills / commands attach

All three plug into the same merge point — no loop change (02 §4.5, 03 §4.4):
- **External MCP** — a third *emit/consume* adapter `resolveRuntimeMcpTools` symmetric to the SDK's `resolveSdkMcpServers` (`container.ts:787-792`): reuse `resolveMcpServers` (`nativeDiscovery:false`) + `FileMcpServerCatalog`, then an **embedded `RuntimeMcpClient`** (infra, over `@modelcontextprotocol/sdk`) connects each server, `tools/list`, and wraps each remote tool as a `RuntimeTool` named `mcp__<server>__<tool>` (so `classifyTool` always-allows the `mcp` category). Lifecycle-scoped to the session (open at `start`, close at `stop`), fail-soft on a dead server (mirror the SDK's drop+log).
- **Skills** (the largest net-new surface, 03 §4.2) — a `SkillCatalog` port (`listSkills(cwd)`+`loadBody(name)`, infra adapter generalizing `scanSkills`) + a `Skill` `RuntimeTool` (`{name}`→body, surfaced as the existing `SkillBlock`, `canonical.ts:63-67`) + skill trigger metadata (name+description) injected into the assembled DPI prompt. **This depends on the §5h system-prompt slot (B1): until §5h lands, there is no prompt to inject metadata into** — so M6 sequences after M1. Skill-bundled scripts/assets need path resolution (§5c).
- **Commands** — Eos control commands already work (`/clear`); add commands = one registry entry. Prompt-template `.md` commands get an Eos-side `expandCommandTemplate` (core domain) invoked in `DispatchMessage` **only when the backend lacks native expansion**, gated on a new capability `expandsSlashTemplates` (CLI/SDK true, in-process false — branch on capability, never kind).

### 4.5 Durability — `ConversationStore`

Introduce a `ConversationStore` port (new, `core/src/ports/`) + a `JsonlConversationStore` infra adapter persisting `LiveSession.messages` keyed by `workerId`+a generated `sessionId` under `~/.eos`. `InProcessBackend.start` emits `{type:"session",phase:"ready",sessionId}` so `processAgentSignal` persists it (`ProcessAgentSignal.ts:94-97`) and boot reconcile keeps the row SUSPENDED (`ReconcileWorkersOnBoot.ts:38`); on `backendOptions.resume`, rehydrate `messages` from the store. Add a distinct `sessionStore` value (e.g. `"eos-conversation"`) to `BackendDescriptor` — **intentionally not loadable by the claude lanes**, so cross-lane handoff stays correctly blocked (`canHandoffBackend`, `backend-switch.ts:21-31`).

### 4.6 The SOLID extension points (how "a new provider = new config, no new class")

| Extension | Mechanism | What you write | What you DON'T touch |
|-----------|-----------|----------------|----------------------|
| New provider (hosted or local) | OCP — `config.backends["x"] = {kind, model, baseUrl, auth, capabilities}` | one config entry (+ optional caps block) | zero classes; no consumer code |
| New built-in tool | OCP — `BuiltinToolRegistry` entry | one `RuntimeTool` + registry line | `buildLaneTooling`, the loop, the gate |
| New slash-command | OCP — `createSlashCommandRegistry([…])` | one `SlashCommand` | `DispatchMessage` |
| New permission mode | OCP — `MODE_SPECS` entry | one verdict table | the decider |
| New wire dialect (rare) | New `ModelClient` adapter | one class implementing the port | the loop, the registry |
| Per-provider quirk | DIP — declared `ProviderCapabilities`, read by adapters | one config field | adapter branching logic |

DIP holds: `ToolRuntime` depends on `ModelClient`/`ToolGate`/`RuntimeTool` abstractions; the composition root resolves credentials and injects concretes. ISP holds: `streamTurn` is optional (the loop falls back to `createTurn`); optional `AgentSession` methods are capability-gated. LSP holds: the conformance suite proves the mandatory `AgentSession` surface across lanes. The `backend-kind-literal-guard` test stays green because every new decision reads `descriptor.*`/`capabilities.*`.

---

## 5. Detailed design per area

Each subsection names the ports/types/contracts touched, new-vs-modified files, and the SOLID rationale.

### 5a. Provider/model abstraction & profiles

**Contracts touched:** `contracts/src/backend.ts` (`AuthRef`, `BackendProfile`), new `ProviderCapabilities`.
**Core ports touched:** `core/src/ports/BackendDefaults.ts` (`ResolvedBackend`), `core/src/ports/AgentBackend.ts` (`BackendLaunchOptions`, `BackendDescriptor`, `ModelCatalogRef`), `core/src/ports/ModelClient.ts` (`ModelTurn`).

Design:
- **`AuthRef.kind` gains `"none"`** for keyless localhost (`backend.ts:17-23`). The `SubscriptionAuthResolver` already returns `scheme:"none"` for any unrecognized kind (`SubscriptionAuthResolver.ts:64`), so the mapping is natural; the OpenAI client must send no/empty `Authorization` without erroring (§5g).
- **`ProviderCapabilities` (new typed schema)** with `wire: "anthropic"|"openai-chat"`, `supportsStreaming`, `supportsTools`, `supportsParallelToolCalls`, `reasoning: "none"|"openai-effort"|"anthropic-thinking"|"reasoning_content"`, `reasoningRoundTrip: "drop"|"preserve-signed"|"none"`, `cache: "none"|"anthropic-explicit"|"automatic"`, `cacheMinTokens?`, `structuredOutput`, `contextWindow`, `maxTokens?`. Lives on `BackendProfile` (recommended: `BackendProfile.capabilities?: ProviderCapabilities` — see §10 decision D2). Defaulted per `kind` so a bare profile still works.
- **`ResolvedBackend.auth?: AuthRef`** added (the §3.2 reconciliation), mapped at `backendDefaults.profile()` (`container.ts:278`).
- **`ModelTurn.providerMetadata?: Record<string,unknown>`** escape hatch; and `ModelMessage` content must be able to carry an opaque signed reasoning block to echo back (for `reasoningRoundTrip:"preserve-signed"`, §5g).
- **Model catalog:** make the UI offer *profiles* (name+kind+model+label) for `modelSource:"profile"` lanes rather than inventing a live `/v1/models` fetch (04 §4.4). `ModelCatalogRef {kind:"static",models}` remains available for an explicit SKU list.
- **Pricing — fix the Opus-default trap (MJ2).** `priceFor` substring-matches Claude names and **falls through to `config.prices.opus`** for anything unrecognized (`container.ts:242`) — so a `deepseek-chat`/`glm-5.2`/local model with no price entry is billed at **Opus rates** through the cost ledger (`handleUsage → priceFor`), live the instant the lane is enabled. The fix is correctness, not UX: **(1)** at config-load and at `POST /api/backends`, **require a `prices` (or per-profile `pricing`) entry for any `costMode:"billed"` profile** (reject/warn otherwise); **(2)** change the `priceFor` fallback for an unknown model from silent-Opus to a **loud known-zero** plus a one-time `provider:error`/warning event (m5) so an unpriced billed turn is observable, never silently 10×-overbilled. Scheduled in **M1** (it ships the instant the billed lane turns on). `effortLevelsFor` returning `null` for non-Claude (effort passes through) is acceptable and unchanged.

SOLID: OCP (new provider = config), DIP (capabilities declared, not heuristic), ISP (`providerMetadata`/`capabilities` optional).

### 5b. Built-in tool harness + the ~16 tools

**Core ports (new):** `BuiltinToolRegistry`, `FileSystem`, `ProcessRunner`.
**Infra (new):** `infra/src/tools/builtins/*.ts` + a registry assembler.
**Manager (modified):** `container.ts` `buildLaneTooling`.

The inventory to implement (canonical names + input fields are **mandatory** — 02 §3.1, 05 §4.1):

| Tool | Category | Input fields | Behavior parity note |
|------|----------|--------------|----------------------|
| `Read` | read | `file_path,offset?,limit?` | `cat -n` line numbers |
| `Write` | fileEdit | `file_path,content` | overwrite |
| `Edit` | fileEdit | `file_path,old_string,new_string,replace_all?` | unique `old_string` required |
| `MultiEdit` | fileEdit | `file_path,edits[]` | sequential edits |
| `NotebookEdit` | fileEdit | `notebook_path,new_source,…` | cell edit |
| `Bash` | shell | `command,timeout?,run_in_background?` | timeout + cwd scope; bg shells tracked by id |
| `BashOutput` | shell | `bash_id` | read bg shell output |
| `KillShell` (`KillBash`) | shell | `shell_id` | both names route to `shell` category (`permission-mode.ts:29`) |
| `Glob` | read | `pattern,path?` | glob match |
| `Grep` | read | `pattern,path?,output_mode?,…` | wraps ripgrep |
| `LS` | read | `path` | list dir |
| `WebFetch` | network | `url,prompt` | fetch+summarize |
| `WebSearch` | network | `query` | search |
| `TodoWrite` | other | `todos[]` | todo list |
| `Task` | other | `description,prompt,subagent_type` | **API-lane subagent** = nested `runTurn` session built **without control tools** (§5e) |
| `ExitPlanMode` | other | `plan` | plan-mode exit |

Blocked (never authored into the surface): `AskUserQuestion`, `Workflow` (`tool-scope.ts:26`); orchestrators additionally lose `Task` (stripped at surface via `disallowedBuiltinToolsFor`, `tool-scope.ts:57-61`).

`buildLaneTooling` merges built-ins into both `items` and `tools`. The built-in surface is filtered through `disallowedBuiltinToolsFor(spec.isOrchestrator)` and through the worker definition's allow/deny globs (already materialized onto the row; the gate enforces, but pre-filtering the *surface* avoids offering a denied tool to the model).

SOLID: OCP (registry), DIP (`FileSystem`/`ProcessRunner` ports so tools are unit-tested without disk), ISP (each tool a tiny `RuntimeTool`). A **shared canonical tool-name enum** in `contracts/` (referenced by `permission-mode.ts` category sets, `tool-scope.ts`, and the registry) is introduced here to make the "wrong name = silent escape" failure unrepresentable (05 §5.3).

### 5c. MCP + skills + commands plumbing

**Core (new):** `McpToolClient` port; `SkillCatalog` port; `core/src/domain/command-template.ts` (`expandCommandTemplate`); `expandsSlashTemplates` capability on `AgentCapabilities`.
**Infra (new):** `RuntimeMcpClient`, `FileSkillCatalog`.
**Manager (modified):** `container.ts` (inject MCP-resolver + skill-catalog deps into the in-process factory; merge in `buildLaneTooling`); `DispatchMessage`/`dispatch-deps.ts` (command expander hook).

- **MCP:** `resolveRuntimeMcpTools(spec)` = `resolveMcpServers({inherited: mcpCatalog.listInherited(spec.cwd), builtins:{}, config: config.mcp.{orchestrator|worker}, nativeDiscovery:false})` → for each server, `RuntimeMcpClient.connect` + `tools/list` → wrap as `RuntimeTool`. Builtins map is **empty** here (Eos control tools are added separately as RuntimeTools, not as MCP servers on this lane). `resolveMcpServers`/`FileMcpServerCatalog`/`AgentMcpConfig` unchanged.
- **Skills (MJ6):** `SkillCatalog.listSkills(cwd): SkillMeta[]` + `loadBody(name): { body, dir }` (infra generalizes `scanSkills`, `commands.ts:67-106`). The `Skill` `RuntimeTool` returns the body; the emit path tags it `SkillBlock(callId)`. **Prompt slot:** trigger metadata (name+description of each discovered skill) is folded into the **§5h** assembled system prompt (via the assembly `extra` path, like the worker-def body) — this is the dependency the review flagged: **the slot exists only because §5h creates it (B1).** **Resource paths:** `loadBody` returns the skill's absolute `dir`; the `Skill` tool surfaces it alongside the body so `Bash`/`Read` can reach bundled scripts/assets (03 §3.2 #4). **Scope (stated plainly, a deliberate cut):** v1 skills = discovery + metadata-in-prompt + **manual `Skill` invocation** — NOT the binary's auto-trigger heuristics (§2.2). G2 coverage must read "skills present, manual-invoke," not "full auto-trigger parity."
- **Commands:** capability-gated `expandCommandTemplate(md,args,ctx)` reads the `.md`, substitutes `$ARGUMENTS`/`$1…`, resolves `@file` + `` !`cmd` `` (via the `Bash` built-in), injects expanded text as the user message before `runTurn`. Discovery reuses `scanCommands`.

SOLID: OCP (third MCP emit adapter, same shape as CLI/SDK), DIP (`McpToolClient`/`SkillCatalog` ports → fakes in tests).

### 5d. Per-worker provider config threading + model assignment across all scopes

This is the **G1+G3 key enabler**. Recommended (DIP-clean "B-explicit", 04 §4.2): carry the profile's *references* (never secrets) to the factory and resolve credentials lazily at `start()`.

1. `ResolvedBackend.auth?: AuthRef` (§5a) + map it at `backendDefaults.profile()` (`container.ts:278`).
2. `BackendLaunchOptions.baseUrl?: string` (`AgentBackend.ts:104-110`; `auth?`/`params?` already exist).
3. Spawn chokepoints forward the resolved `rb` into `spawnWorker` so it sets `backendOptions: {spec, auth: rb.auth, baseUrl: rb.baseUrl, params: rb.params}` (`SpawnWorker.ts:256`, today `{spec}` only). Both `spawn-worker.ts` (`rb` already in scope at `:97`) and `orchestrators.ts:30-60`.
4. **`InProcessEnvFactory` becomes async** (`InProcessBackend.ts:30` → `(spec)=>Promise<InProcessEnv>`; `start` awaits at `:134`). The `container.ts` factories (`:758-777`) read `spec.backendOptions.{auth,baseUrl,params}`, do `const creds = await authResolver.resolve(auth)`, and build `createOpenAIModelClient({apiKey: creds.apiKey ?? "", baseUrl: baseUrl ?? creds.baseUrl, model: spec.model, ...params})`. **Every `process.env.*` read is dropped.** Note `buildLaneTooling` stays **sync** — only credential resolution becomes async (04 §5 coordination point).
5. **`WorkerDefinition.backendProfile?: string`** (`worker-definition.ts:25`), carried in `applyWorkerDefinitionDefaults` (`worker-definition-resolution.ts:84-97`), fed as `explicitProfileName` into the resolver (which already honors it first, `SqlBackedBackendResolver.ts:39-42`). Now **any scope** — built-in (`manager/workers/*.md`), user (`~/.eos/workers/*.md`), project (`.eos/workers/*.md`), runtime (`create_worker`) — can declare `backendProfile: glm-local`. `model`/`backendKind` stay for back-compat.

**All-scopes interoperation (G3):** the resolver's 4-tier precedence (profile → parent-inherit → role default → claude-cli, `SqlBackedBackendResolver.ts:35-65`) already makes "orchestrator on Y, worker on X" work — a child inherits the parent's backend unless it overrides. The orchestrator is assigned via `config.defaults.orchestrator.backend` or `POST /orchestrators{backendKind}` (`orchestrators.ts:23-66`) — the *least*-gapped path, blocked only by the same threading+enablement gaps. Cross-provider workers all emit the same canonical `AgentEvent`s, so they render and bill uniformly.

SOLID: DIP (composition root owns credential resolution; adapter stays env-agnostic), ISP (`backendProfile` one optional field, one resolver tier already present).

### 5e. Permissions / gating completion

**The one real fix (05 §3.1) — 2 edits, no contract change:**
- (a) `core/src/use-cases/ToolRuntime.ts`: widen `ToolGate.decide`'s return to `{allow:boolean; message?:string; updatedInput?:Record<string,unknown>}` (`:21-24`) and in `executeGated` invoke `tool.execute(decision.updatedInput ?? input)` (`:127`).
- (b) `manager/backends/PolicyToolGate.ts:16`: `d.behavior === "allow" ? {allow:true, updatedInput: d.updatedInput} : {allow:false, message:d.message}`. `sdkPolicy` already returns `updatedInput` (`container.ts:731`), so no `PolicyDecider` change.

This restores parity with SDK (`SdkPermissionBridge.ts:31`) and CLI (`auto-allow.sh:44`) for policy `rewrite` rules and human-edited "ask" approvals — without any `kind` branch.

**`Task` (subagent) on the API lane — full design (MJ5).** A built-in is a bare `RuntimeTool` whose `execute(input)` receives *only* `input` (`ToolRuntime.ts:16-19`) — it has no handle to the model/tools/gate/emit a child loop needs. So `Task` cannot be a plain registry tool; it is **constructed by `buildLaneTooling` as a closure** over the env-factory ingredients (the same scope that already holds `makeToolContext`, the dialect-client builder, `sdkPolicy`, and `assembleAppendFor`). The closure's `execute({description, prompt, subagent_type})`:
1. **Child surface:** builds a child `tools` map = built-ins (+ optional MCP) **without any Eos control tools** (the primary isolation defense — natural since the surface is assembled here), filtered by `disallowedBuiltinToolsFor` and the parent's depth.
2. **Child instructions (depends on §5h):** `system = assembleAppendFor(childSpec, childId, "in-process")` where `childSpec` carries `workerDefinition = subagent_type` — Explore/Plan/general-purpose are existing built-in worker definitions (`manager/workers/*.md`), so the child gets a real role prompt through the *same* assembler. (A subagent with no role prompt is useless — this is why MJ5 compounds B1.)
3. **Child model/gate:** reuse the parent's resolved creds + dialect (`createXModelClient(creds, caps, childTools, system)`); gate = `makePolicyToolGate(childId, sdkPolicy, { agentId: childId })` so rung-0.5 (`PolicyGatewayService.ts:139`) hard-denies any control-plane call the child attempts (defense-in-depth atop the surface omission). **Creds coherence (N2):** `buildLaneTooling` is sync and `spec`-only today (`container.ts:743`), but resolved creds come from the `await authResolver.resolve(...)` in the **async** env factory (§5d). So the `Task` closure is constructed *inside that async-factory scope, after cred resolution* — capturing the resolved creds + the dialect-client builder by closure — OR `buildLaneTooling` receives them as params; either way the child builds its model client from the resolved creds, **never** from `process.env` or the bare spec. `buildLaneTooling` itself stays sync (§5d / D-invariant).
4. **Run + surface:** `await runTurn({model, tools, gate, emit: childEmit, signal}, [{role:"user", content: prompt}])`; `childEmit` re-tags blocks with the child's id (`parentCallId` on tool blocks, `canonical.ts:49`) so the UI/FSM attribute child activity to the parent call. Returns the child's final assistant text as the tool-result string.
5. **Depth + abort:** a depth counter threads through the closure (cap, e.g. 2) → over-cap `Task` returns an error result, not a deeper loop; the child shares (or links to) the parent `signal` so an interrupt propagates. Note the nested `runTurn` blocks the parent's `executeGated` await synchronously — acceptable (same as a long `Bash`), bounded by the child's own `maxIterations`.

**`AskUserQuestion`/`Workflow`/orchestrator-`Task` exclusion:** stripped at surface-build (§5b) via `disallowedBuiltinToolsFor(spec.isOrchestrator)`, belt-and-suspendered by the gate's `BLOCKED_BUILTIN_TOOLS` deny.

Reused unchanged: `PolicyGatewayService`, `permission-mode.ts`, `policy.ts`, the resolvers, `tool-scope.ts`, policy.yaml, the Bun gateway (CLI-only). The long-poll "ask" already works on the API lane for free (05 §3.5). **Roadmap:** `Task` lands in **M2** (it needs the built-in surface + §5h's prompt slot, both M1/M2).

SOLID: the gate fix widens a shared abstraction uniformly (no branching); the canonical-naming requirement (§5b) is what makes the whole stack apply for free; `Task` reuses the env factory + DPI assembler rather than forking a second loop (DRY/DIP).

### 5f. Durability / resume

**Core (new):** `ConversationStore` port. **Infra (new):** `JsonlConversationStore`. **Modified:** `InProcessBackend.ts` (constructor signature + start/kickTurn/attach), `AgentBackend.ts` (`sessionStore` enum + per-kind `resumable` cap), `IdGenerator.ts` + `RandomIdGenerator.ts` (`newSessionId`).

- **`ConversationStore`:** `save(workerId, sessionId, messages)`, `load(sessionId): ModelMessage[] | null`, `delete(sessionId)`. JSONL under `~/.eos/conversations/<sessionId>.jsonl` (rewrite-on-save or append; rehydrate by replay). Treated as non-regenerable user data (never `rm` by hand).
- **Injection seam (MJ7 — the missing wiring).** `ConversationStore` is *not* in `InProcessEnv` (that is `{model,tools,gate}`, rebuilt per `start`); a conversation outlives any single env. So **`createInProcessBackend` gains a third arg:** `createInProcessBackend(kind, envFactory, deps?: { store?: ConversationStore; ids?: IdGenerator })`. The arg is **optional** — tests/conformance pass none → no persistence, the 5 invariants stay green unchanged. `LiveSession` gains a `sessionId: string` field.
- **sessionId source (MJ7).** Add `newSessionId(): string` to the `IdGenerator` port (`core/src/ports/IdGenerator.ts`) + adapter (`RandomIdGenerator.ts` → `"s-" + rand(8)`), injected as `deps.ids`. **No `Math.random` in the backend** — it uses the same injected generator the rest of the daemon does (`c.ids`). `start` sets `s.sessionId = spec.backendOptions?.resume ?? deps.ids.newSessionId()` and emits `{type:"session",phase:"ready",sessionId: s.sessionId}` (→ `setSessionId`, `ProcessAgentSignal.ts:94-97`).
- **Save point (MJ7).** In `kickTurn`'s existing `.then((msgs) => { s.messages = msgs; })` (`InProcessBackend.ts:80`), append `deps.store?.save(workerId, s.sessionId, msgs)` — i.e. persist after each settled turn, at the one place the conversation is already mutated.
- **Resume.** `start` reads `spec.backendOptions.resume` (the persisted `session_id`); if set, `deps.store?.load(resume)` seeds `LiveSession.messages` before the first turn. Reconcile + `ResumeWorker` already work once a `session_id` exists (`ReconcileWorkersOnBoot.ts:38`, `ResumeWorker.ts:52`); the in-process `resumeWorker` already forces an IDLE settle (`:116-118`). New descriptor `sessionStore:"eos-conversation"` + per-kind `capabilities.resumable:true`.
- **`attach()` dead-but-"alive"-looking hazard (MJ7, finding 01 §3.1).** `attach(workerId)` returns `sessionFor(workerId)` unconditionally (`InProcessBackend.ts:143-145`); after a restart with no `live` entry, its methods 410 and **`isAlive()` already returns `live.has(workerId)` → `false`** (so liveness is honest), but the returned object is non-null and *looks* usable. Resolution: **(a) the daemon's restart-resume path goes through `start({backendOptions.resume})`, never `attach`** (`ResumeWorker.ts:76-91`) — `attach` is only for live workers (message/kill/interrupt) — and we document this as the contract; **(b) harden `attach`** to lazily rehydrate when the store + factory are present: if `!live.has(workerId)` but the worker row carries a `session_id`, rebuild the `LiveSession` (env via `envFactory`, messages via `store.load`) so `attach` returns a genuinely-alive, resumable session instead of a misleading husk. (b) is the robust option; (a) is the minimum and already matches daemon behavior — ship (a), add (b) if any live path is found to call `attach` post-restart.
- **`/clear` correctness (01 Option E, 03 §5.2):** emit `{type:"session",phase:"cleared"}` from `InProcessBackend.clearContext` (`:104-110`) so the FSM context/task reset fires (`ProcessAgentSignal.ts:100-109`); also `deps.store?.delete(s.sessionId)` then start a fresh sessionId.

SOLID: a new port + adapter (DIP); the optional `deps` arg keeps the backend usable with zero persistence (ISP — conformance unaffected); the new `sessionStore` value extends the enum without enabling cross-lane handoff (OCP + correctness).

### 5g. Provider normalization (the cross-provider footguns)

Driven entirely by `ProviderCapabilities` (§5a) — adapters branch on declared facts:

- **Reasoning round-trip — THE #1 hazard, OPPOSITE across providers (06 §4.4).** DeepSeek 400s if `reasoning_content` is echoed back; Anthropic 400s if signed `thinking` blocks are *not* preserved across tool turns. Today `toOpenAIMessage` drops reasoning (correct for DeepSeek, `OpenAIModelClient.ts:89-97`) and `toAnthropicMessage` drops thinking (latently wrong once Anthropic thinking is enabled, `AnthropicModelClient.ts:64-76`). Fix: `reasoningRoundTrip:"drop"` (OpenAI/DeepSeek) vs `"preserve-signed"` (Anthropic) — and for preserve, the neutral `ModelMessage`/`ModelTurn` must carry the opaque signed block (via `providerMetadata`/an assistant content block) to re-emit unmodified.
- **Caching (06 §4.1).** Anthropic lane injects **no** `cache_control` today → zero caching on a large, stable DPI prefix. For `cache:"anthropic-explicit"`, place `cache_control` breakpoints on the system block + tool schemas (the stable prefix); for `cache:"automatic"` (OpenAI/DeepSeek), no-op. Only prefix-stability discipline is portable.
- **Token/cache accounting (06 §3.5).** `OpenAIModelClient` reads no `cached_tokens` (`:129`) → `cacheReadTokens` always 0 on the OpenAI lane. Map each provider's cache field into `ModelTurn.usage.cacheReadTokens` (`usage.prompt_tokens_details.cached_tokens` for OpenAI; `prompt_cache_hit_tokens` for DeepSeek; `cache_read_input_tokens` for Anthropic — already read).
- **Structured output (06 §4.2).** JSON Schema is the portable core; the wrapper differs (`response_format` vs `output_config.format` vs `guided_json` vs `format`). Drive from `capabilities.structuredOutput`; emit a conservative lowest-common-denominator schema (no recursion/$ref/numeric/string constraints).
- **Effort/reasoning params (06 §4.4).** OpenAI `reasoning_effort` enum vs Anthropic thinking budget/effort vs DeepSeek/GLM `thinking:{type}`. Map `params.effort` per `capabilities.reasoning`. `max_tokens` becomes capability-driven (`AnthropicModelClient` defaults 4096, `:36` — too low for reasoning models).
- **Anthropic `streamTurn` (06 §3.3).** Add a **separate** SSE parser (`message_start`→`content_block_*`→`message_delta`→`message_stop`; tool input as `input_json_delta.partial_json` accumulated to `content_block_stop`; `thinking_delta`+`signature_delta`; cumulative usage = last value). Share only `ModelStreamCallbacks` with the OpenAI parser. Set `capabilities.supportsStreaming`/per-kind `streamingThinking:true` so the loop streams and the UI renders.
- **OpenAI-compatible robustness (06 §2.3).** Tolerate missing `index`/`id`/`type` on streamed tool deltas; treat `tool_choice`/structured-output/effort as droppable per capability (the LiteLLM `drop_params` lesson); prefer non-streaming for known-broken parsers (`supportsStreaming:false`, e.g. Ollama `/v1`+tools). Keyless localhost: tolerate an empty `apiKey` (send no `Authorization` header when `scheme:"none"`).
- **Retry / backoff / rate-limit (MJ3).** Today both clients do a single `fetch`; `!resp.ok` → `{stopReason:"error"}` (`OpenAIModelClient.ts:49-51`, `AnthropicModelClient.ts:55-58`) and `ToolRuntime` ends the turn (`:83-86`) — a single 429/5xx kills a metered orchestrator mid-task. Add a **bounded exponential backoff** (honoring `Retry-After`) on **429/500/502/503/529**, as a shared `withRetry(doFetch, policy)` wrapper *inside* the two clients — distinct from the hard error that ends the turn (only a *non-retryable* status, or exhausted retries, becomes `stopReason:"error"`). It is shared infra, **not** a per-provider branch; bounds (`maxRetries`, base/cap) are capability-gated knobs with safe defaults. **Roadmap: M4** (hardening). Until then, document that M1–M3 API workers die on the first sustained rate-limit.
- **Context-window management / compaction (MJ4).** The loop never trims history — `runTurn` only pushes (`ToolRuntime.ts:93,99`) and `InProcessBackend` accumulates `s.messages` (`:80`) — and `contextWindow` (§5a) was declared with **no consumer**. G1 explicitly targets **local models with small (8k–32k) context**, which will hard-400 within a few tool turns; the SDK/CLI lanes get auto-compaction from the bundled binary for free, so this is also a **G2 parity** gap. Design, in two stages so the field is never "declared-but-unused":
  - **M1 interim — fail-fast guard.** Before each model call, estimate `messages` tokens (cheap `chars/4` heuristic) vs `capabilities.contextWindow`; if over a high-water mark (e.g. 0.9×), abort the turn with a **typed, clear** error (`turn:error reason:"context_window_exceeded"`) rather than a raw provider 400. This ships *with* the lane so a small-context misconfig is diagnosable from day one.
  - **M4 — real compaction.** A `ContextCompactor` (injected into the in-process loop deps, reading `capabilities.contextWindow`) drops/summarizes the oldest *tool* turns (keeping the system prompt + the latest user task + a short summary marker) when projected tokens approach the window. Also map Anthropic `model_context_window_exceeded` → a recoverable compaction trigger, not a generic error (`AnthropicModelClient.ts:96-97`). **Matched-pair granularity (D8 caution):** compaction MUST evict at whole tool-turn boundaries — an orphaned `tool_use` left without its `tool_result` (or vice-versa) is itself a 400 on Anthropic. "Drop oldest *tool turns*" preserves pairing only if implemented faithfully; the M4 compaction test asserts no orphaned `tool_use`/`tool_result` survives a compaction pass.
- **Provider-error observability (m5).** A round-trip 400, a keyless-localhost connection refusal, or a billed turn with no matching price currently collapse into a generic `turn:error` / a silent Opus default. Emit a **typed structured log + a diagnostic event** (e.g. `provider:error` with `{kind, status, sessionId}`) on these paths so a multi-provider misconfig is diagnosable. Folds into the existing event/SSE bus; **roadmap M4** (alongside retry, which produces most of these signals).

SOLID: every quirk is data (`ProviderCapabilities`), read by two thin adapters; **gating over silent-dropping** (06 §3.4) matches Eos's fail-closed posture; retry/compaction/observability are shared infra injected via ports (DIP), not `kind` branches.

### 5h. System-prompt / DPI delivery on the in-process lane — THE BLOCKER (B1)

**The gap (verified).** The in-process lane gives the model its *tools* but no *instructions*. The factories build `createAnthropicModelClient({apiKey, model, tools})` / `createOpenAIModelClient({apiKey, model, baseUrl, tools})` with **no `system`** (`container.ts:761,771`); `InProcessBackend.start` pushes only `spec.prompt` (the user task) as a `user` message (`:140`) and never reads `spec.systemPromptFile`; and `assembleAppendFor` — the DPI + injected-memory assembler — is invoked **only** by the SDK lane (`container.ts:804`) and projected to a file by the CLI lane (`assembleSystemPromptFile`, `:679-685`). Result: no role framing, no Eos reporting/orchestration protocol, no worker-definition body, no injected CLAUDE.md. The SDK lane documents the consequence: an agent that "has the MCP tools but ignores them" (`ClaudeSdkBackend.ts:73-77`). On the API lane it is worse — there is no `claude_code` preset either, so the worker has *nothing*. This is foundational: G2/G3 worker-instruction parity and the §5c skills metadata-injection both require this slot.

**Contracts/ports touched:** none new — the delivery *target* already exists (`AnthropicModelClientOpts.system`/`OpenAIModelClientOpts.system`, both used at `:37`). The change is **wiring only**, in `manager/container.ts` + `infra/src/backends/InProcessBackend.ts`.

**Design (concrete).**
1. **Reuse `assembleAppendFor` with a new lane value `"in-process"`.** It already composes the DPI text (`assembleAppendText` → `assembleSystemPrompt` with the worker-definition body as a synthetic `role/20` fragment, `container.ts:601-663`) **plus** injected memory, where the lane parameter controls memory injection: `composeAppendedPrompt(dpi, selectInjectableMemory(snapshot, backendKind))` (`:674`). `selectInjectableMemory` drops only sources whose `assumeNativeFor` includes the lane; **`"in-process"` is native to nothing, so ALL memory (CLAUDE.md, project/user) is injected** — exactly right, since this lane has no binary and no `settingSources` to auto-load it. This is the same correctness the CLI lane gets by filtering out its *native* CLAUDE.md; in-process filters out nothing.
2. **Deliver it as the model's `system`.** The async env factory (§5d) already receives the `AgentLaunchSpec`, whose `backendOptions.spec` is the `SpawnWorkerSpec` (the same source the SDK lane reads at `:804`). It calls `const system = assembleAppendFor(spec.backendOptions.spec, spec.workerId, "in-process")` and passes `system` into `createAnthropicModelClient`/`createOpenAIModelClient`. (Both already prepend `system` to the request — Anthropic via the top-level `system` field `:37`, OpenAI via a `{role:"system"}` message `:37`.)
3. **Complete prompt, not a delta — and PRE-AUTHOR the base harness (N1).** Unlike the SDK/CLI append (which layers onto the binary's `claude_code` base harness, `ClaudeSdkBackend.ts:305`), the in-process `system` is the *only* instruction channel, so it must be self-sufficient. The Eos *operational* protocol (reporting contract, `mcp__worker__*` usage) IS in the DPI append, so "has tools but ignores them" is genuinely closed; the residual is base-model framing (date/OS/tone, generic tool etiquette) that `claude_code` normally supplies — and it matters **most for the raw `anthropic-api` profile, which has no preset behind it at all** (OpenAI-compatible chat models carry more of this from their own post-training). So **do not wait for a gap to appear:** pre-author a single **`lane/in-process` base fragment** (a small standing harness preamble) and inject it through the assembly `extra` path keyed on the lane parameter — **never a `when` gate** (the immutable-`when` rule forbids gating on backend; the *lane parameter* is the sanctioned channel for lane-specific text, 04 §2.8/§4.6). The fragment is content-only, so it carries no architectural risk; shipping it in M1 makes API-lane behavior match the SDK lane out of the box rather than after a field report.
4. **`/clear` + resume keep it.** The system prompt is rebuilt by the factory on each `start` (incl. a `/clear` restart and a resume rehydrate), so it is never lost; it lives outside the persisted `messages` (§5f), matching the SDK lane where the append is re-supplied per launch.
5. **Subagents (Task) reuse this exact mechanism** — a `Task` child's system prompt is `assembleAppendFor(childSpec, childId, "in-process")` with `childSpec.workerDefinition = subagent_type` (§5b/§5e). B1's slot is therefore also the subagent-prompt slot.

**Roadmap home:** **M1** (foundation) — it must precede M2's worker-instruction-dependent behavior and M6's skill-metadata injection. **Test (behavioral, not just structural — N1):** beyond asserting `system` is non-empty and contains the worker protocol + definition body, the M1 acceptance test runs a **real task on a real (localhost-stub) model and checks the agent actually USES its instructions/tools** — i.e. an API-lane worker (incl. the raw `anthropic-api` profile + the pre-authored base fragment) reaches the same observable outcome as the SDK lane on the same definition (calls the expected tool, emits the expected report shape). "Non-empty system" alone is necessary but not sufficient. Until this passes, no G2/G3 acceptance can.

SOLID: OCP/lane-parameter (lane-specific prompt content flows through the assembly lane arg, not a `when` gate or a `kind` branch); DRY (reuses the one DPI assembler all lanes share — byte-identical instructions across lanes is exactly what makes "the same definition is the same agent on any provider," G3).

---

## 6. Contracts & schema changes (concrete deltas)

All in `contracts/` (Zod SSOT) unless a core port is named. Each is additive/backwards-compatible.

```
# contracts/src/backend.ts
AuthRefSchema.kind: enum [...,"none"]                     # keyless localhost (was subscription|env|keychain)
BackendProfileSchema.capabilities?: ProviderCapabilities  # typed quirks (see below) — RECOMMENDED (D2)

# contracts/src/provider-capabilities.ts (NEW)
ProviderCapabilitiesSchema = {
  wire: enum ["anthropic","openai-chat"],
  supportsStreaming: boolean, supportsTools: boolean, supportsParallelToolCalls: boolean,
  reasoning: enum ["none","openai-effort","anthropic-thinking","reasoning_content"],
  reasoningRoundTrip: enum ["drop","preserve-signed","none"],   # the #1 hazard
  cache: enum ["none","anthropic-explicit","automatic"], cacheMinTokens?: number,
  structuredOutput: enum ["none","openai-response_format","anthropic-output_config","vllm-guided_json","ollama-format"],
  contextWindow: number, maxTokens?: number,
}

# contracts/src/worker-definition.ts
WorkerDefinitionSchema.backendProfile?: string           # pin a provider on any worker scope

# contracts/src/canonical.ts
(no change to BackendKindSchema — the 5 kinds stay; new providers are PROFILES of kind "openai"/"anthropic-api")

# contracts/src/http.ts
ROUTES += POST /api/backends                             # add-provider write route (§7)

# core/src/ports/AgentBackend.ts
BackendDescriptor.sessionStore: enum [...,"eos-conversation"]   # durable in-process store (non-handoffable)
AgentCapabilities.expandsSlashTemplates?: boolean              # CLI/SDK true, in-process false
BackendLaunchOptions.baseUrl?: string                          # was missing (auth?/params? already present)
# per-kind descriptor caps: streamingThinking?/resumable? true on enabled in-process kinds

# core/src/ports/BackendDefaults.ts
ResolvedBackend.auth?: AuthRef                            # the §3.2 reconciliation (mapped at profile())

# core/src/ports/ModelClient.ts
ModelTurn.providerMetadata?: Record<string,unknown>      # native escape hatch (signed thinking, native stop, cache)
ModelMessage content: may carry an opaque signed reasoning block (reasoningRoundTrip:"preserve-signed")

# core/src/use-cases/ToolRuntime.ts
ToolGate.decide → { allow: boolean; message?: string; updatedInput?: Record<string,unknown> }   # +updatedInput

# core/src/ports/ConversationStore.ts (NEW)
ConversationStore = { save(workerId,sessionId,messages); load(sessionId): ModelMessage[]|null; delete(sessionId) }

# core/src/ports/BuiltinToolRegistry.ts (NEW)  — Map<string,RuntimeTool> assembler (Open/Closed)
# core/src/ports/FileSystem.ts, ProcessRunner.ts (NEW) — DIP for built-ins
# core/src/ports/SkillCatalog.ts (NEW) = { listSkills(cwd): SkillMeta[]; loadBody(name): { body, dir } }
# core/src/ports/McpToolClient.ts (NEW) — embedded MCP client seam (connect/list/call/close)

# core/src/ports/IdGenerator.ts (MOD)
newSessionId(): string                                   # MJ7 — durability sessionId source ("s-"+rand)

# core/src/ports/ContextCompactor.ts (NEW)               # MJ4 — drop/summarize oldest tool turns near contextWindow
ContextCompactor = { compact(messages, capabilities): ModelMessage[] }   # injected into the in-process loop deps

# RetryPolicy (MJ3) — internal to the two model clients (no port): withRetry(doFetch, {maxRetries,base,cap})
#   honors Retry-After on 429/500/502/503/529; capability-gated knobs; only exhausted/non-retryable → stopReason:"error"

# createInProcessBackend (MOD signature) — infra/src/backends/InProcessBackend.ts
createInProcessBackend(kind, envFactory, deps?: { store?: ConversationStore; ids?: IdGenerator })  # MJ7

# System-prompt delivery (B1) — NO contract change; wiring only:
#   model clients already accept `system` (AnthropicModelClientOpts.system / OpenAIModelClientOpts.system);
#   the async env factory passes system = assembleAppendFor(spec.backendOptions.spec, id, "in-process").
```

---

## 7. Config & UX surface

### 7.1 `~/.eos/config.json` provider/profile schema (mostly expressible today)

```jsonc
"backends": {
  "glm-local":  { "kind": "openai", "model": "glm-5.2",
                  "baseUrl": "http://localhost:11434",              // ORIGIN ONLY — client appends /v1/chat/completions
                  "auth": { "kind": "none" },                       // keyless localhost (NEW kind)
                  "costMode": "billed",
                  "params": { "temperature": 0.2, "max_tokens": 8192 },
                  "capabilities": { "wire": "openai-chat", "reasoningRoundTrip": "drop",
                                    "cache": "automatic", "supportsStreaming": true, "contextWindow": 32768 } },
  "deepseek":   { "kind": "openai", "model": "deepseek-chat",
                  "baseUrl": "https://api.deepseek.com",            // origin only (NOT .../v1)
                  "auth": { "kind": "keychain", "ref": "eos-deepseek" },
                  "costMode": "billed",
                  "capabilities": { "wire": "openai-chat", "reasoningRoundTrip": "drop", "contextWindow": 65536 } },
  "anthropic-billed": { "kind": "anthropic-api", "model": "claude-opus-4-8",
                  "auth": { "kind": "keychain", "ref": "eos-anthropic" }, "costMode": "billed",
                  "capabilities": { "wire": "anthropic", "reasoningRoundTrip": "preserve-signed",
                                    "cache": "anthropic-explicit", "contextWindow": 200000 } }
                  // ⚠ do NOT set params.thinking on this profile before M4 — the preserve-signed
                  //   round-trip carrier lands in M4; enabling thinking earlier 400s on multi-turn tool loops (m4).
},
"defaults": { "orchestrator": { "backend": "deepseek" }, "worker": { "backend": "glm-local" } },
"prices":   { "glm-5.2": { "input": …, "output": … }, "deepseek-chat": { … } }   // REQUIRED for any costMode:"billed" profile (MJ2)
```

**`baseUrl` convention (MJ1).** `baseUrl` is the **origin only** (scheme+host[+port], no version path) — the client owns the version + path: `OpenAIModelClient` strips a trailing slash and POSTs to `${base}/v1/chat/completions` (`:29,41,67`); `AnthropicModelClient` to `${base}/v1/messages` (`:43`). A user-supplied `http://localhost:11434/v1` would yield a doubled `/v1/v1/...` 404. The `POST /api/backends` write path (§7.2) **normalizes** (strips a trailing `/v1` or `/`) and the M1 acceptance test asserts the exact composed URL.

### 7.2 Add-provider flow (key / localhost) — `POST /api/backends`

A new route (ROUTES in `contracts/src/http.ts`) that:
1. **Validates** the request: **normalize `baseUrl` to origin-only** (strip a trailing `/v1` or `/`, MJ1); and if `costMode:"billed"`, **require a matching `prices`/`pricing` entry** (reject otherwise, MJ2) so a billed profile can never bill at the Opus default.
2. Writes the user's API key to the **macOS Keychain** via a new `writeKeychainSecret` companion to `readKeychainSecret` (`SubscriptionAuthResolver.ts:39-46`, uses `security add-generic-password`). For keyless localhost, skip.
3. Writes a `BackendProfile` with `auth:{kind:"keychain",ref}` (or `{kind:"none"}`) + normalized `baseUrl` + `model` (+ optional `capabilities`) to `~/.eos/config.json`.
4. Calls `container.reloadConfig()`.

**The raw key NEVER enters `config.json` or SQLite — only the reference** (the `AuthResolver` invariant: creds are references, resolved lazily, never persisted/logged). Authz + secret-exposure handling on this route is a permission concern (05 §4.4) — gate it to the operator only.

### 7.3 Assigning a model/provider to orchestrator + any worker scope

- **Orchestrator:** `config.defaults.orchestrator.backend = "deepseek"`, or `POST /orchestrators {backendKind}`.
- **Built-in/project/user/runtime worker:** add `backendProfile: glm-local` to the definition (frontmatter or `create_worker`). Inheritance fills the rest (a child inherits the orchestrator's provider unless it sets its own).
- **Picker:** `GET /api/ui-config` (`uiConfig.ts:5-22`) gains the configured `backends` (name+kind+model+label) so the composer offers *profiles* for `modelSource:"profile"` lanes; request-model lanes keep the Claude catalog.

---

## 8. Phased implementation roadmap

Each milestone is independently shippable & testable and states what it unblocks. Build order respects dependencies. (Per the directive, the roadmap is never truncated.)

> **Quick-wins Q0 (no dependency, land first — these are LIVE defects in today's code, not just plan items):**
> - **Q0a — `updatedInput` gate fix** (§5e a+b, 2 edits). Strict safety fix; `sdkPolicy` already returns `updatedInput`. Verified by a policy-rewrite test asserting the API gate applies the rewritten input.
> - **Q0b — `baseUrl` `/v1` convention + normalize (MJ1).** Define origin-only; normalize on `POST /api/backends`; fix is in the write path + the §7.1 examples (already corrected). Verified by asserting the composed URL.
> - **Q0c — pricing fallback (MJ2).** Change `priceFor`'s unknown-model fallback from silent `config.prices.opus` (`container.ts:242`) to a loud known-zero + a one-time warning event. (Pairs with M1's "require a price for billed profiles.") Verified by a `priceFor("deepseek-chat")`-with-no-entry test.
>
> Q0b/Q0c are independent of the lane being enabled and prevent a wrong-endpoint 404 and silent 10×-overbilling the moment M1 turns the lane on.

### M1 — Foundation: instructions + contracts + per-worker provider threading + enablement (the B1/G1/G3 enabler)
- **Build (the BLOCKER first):** **B1 — system-prompt / DPI delivery (§5h):** wire the async env factory to `system = assembleAppendFor(spec.backendOptions.spec, id, "in-process")` and pass it to both model clients (new `"in-process"` lane value → `selectInjectableMemory` injects all memory); **pre-author the `lane/in-process` base-harness fragment (N1)** so the raw `anthropic-api` profile (no preset behind it) gets base framing out of the box. This is foundational and **must precede** any milestone claiming worker-instruction parity.
- **Build (the rest):** all backwards-compatible contract deltas (§6: `AuthRef "none"`, `ResolvedBackend.auth`, `BackendLaunchOptions.baseUrl`, `WorkerDefinition.backendProfile`, `ProviderCapabilities` incl. `contextWindow`, `ModelTurn.providerMetadata`, `IdGenerator.newSessionId`); thread `rb.{auth,baseUrl,params}` resolver→spec→**async env factory**→`authResolver.resolve`→model client (§5d); keyless-localhost empty-key tolerance + `cached_tokens` read in `OpenAIModelClient` (§5g); profile-centric picker + `POST /api/backends` (with baseUrl-normalize + billed-price validation, §7.2) + `writeKeychainSecret`; **require a price for every `costMode:"billed"` profile (MJ2);** a **fail-fast context-window guard (MJ4 interim)** that aborts with a typed `context_window_exceeded` before a small-context 400; make `sessionFor`'s returned `CAPS` **kind-aware** so `streamingThinking` etc. vary per provider, not just the descriptor (m1); enable the descriptors (`enabled:true`) + a UI metered-billing `costMode:"billed"` opt-in.
- **Dependencies:** Q0 (safety + the two live defects) recommended first.
- **Ship:** any provider assignable to the **orchestrator** and **any worker scope** by profile, reaching the right endpoint with the right (or absent) key, **with full Eos instructions** (role/protocol/definition-body/memory) — so a `glm-local` worker is the *same agent* as the same definition on the SDK lane. Orchestrator-on-GLM is demonstrable end-to-end.
- **Known limitations to document (this milestone):** Anthropic-API `createTurn` is non-cancellable mid-request until M4 streaming (m2); profileless/ad-hoc metered `backendKind` picks get no `baseUrl`/`auth` — **require metered selection via a named profile** (m3); no retry/compaction until M4 (the fail-fast guard is the interim).
- **Test:** integration test spawning an API worker on a configured profile (fake/local model) asserting **(a) BEHAVIORAL B1 parity — not just a non-empty `system`: on a real task the API-lane worker (incl. raw `anthropic-api`) uses its instructions/tools to reach the same observable outcome as the SDK lane on the same definition (N1)**, (b) the per-worker `baseUrl`+`auth` it receives, (c) the composed URL is exactly `<origin>/v1/...` (MJ1), (d) a billed profile with no price is rejected (MJ2); multi-scope assignment + inheritance test.
- **Unblocks:** everything (the lane can now reach a configured provider per worker *and instruct it*).

### M2 — Built-in tool harness (the G2 enabler for filesystem/shell)
- **Build:** `BuiltinToolRegistry`/`FileSystem`/`ProcessRunner` ports; the ~16 bare-named `RuntimeTool`s (§5b); the shared canonical tool-name enum; merge built-ins into `buildLaneTooling` (items+tools) with `disallowedBuiltinToolsFor` stripping + worker-def allow/deny pre-filter; **`Task` per the full §5e design** (closure over the env-factory ingredients → child surface without control tools + child DPI prompt via `assembleAppendFor(childSpec,"in-process")` + child emit re-tagging + depth cap + `agentId` gate isolation) — MJ5.
- **Dependencies:** M1 (a reachable provider to test against **and** the §5h prompt slot — `Task`'s child needs a role prompt, so it cannot precede B1).
- **Ship:** API workers Read/Write/Edit/Bash/Glob/Grep with SDK/CLI-parity semantics; gated by the existing policy stack for free.
- **Test:** cross-lane tool-behavior conformance suite (API `Read`/`Edit`/`Bash` match SDK semantics); cross-lane gating suite (editRegex deny, Bash command deny, mode ask/allow, blocked-builtin deny, **rewrite applied** — depends on Q0).
- **Unblocks:** G2 core; the nested-`Task` subagent.

### M3 — Durability / resume (the G3 "persistent orchestrator survives restart")
- **Build:** `ConversationStore` port + `JsonlConversationStore`; emit `session ready+sessionId` + persist/rehydrate messages; `sessionStore:"eos-conversation"` + `resumable:true`; `/clear` emits `session:"cleared"` (§5f).
- **Dependencies:** M1 (a real configured lane to persist).
- **Ship:** API workers (incl. a metered orchestrator) survive a daemon restart instead of being closed DONE.
- **Test:** restart integration test — spawn API worker, persist a turn, simulate boot reconcile, assert SUSPENDED→resume with conversation intact.
- **Unblocks:** production use of a metered orchestrator (G3 across restart).

### M4 — Provider normalization & robustness hardening (correctness + production-grade across providers)
- **Build:** `ProviderCapabilities`-driven reasoning round-trip (`drop` vs `preserve-signed` with signed-block carrying), Anthropic `cache_control` injection, per-provider token/cache field mapping, structured-output envelope selection, effort/`max_tokens` mapping, and **`AnthropicModelClient.streamTurn`** (separate SSE parser) (§5g); **retry/backoff with `Retry-After` on 429/5xx** (`withRetry`, MJ3); **real context compaction** (`ContextCompactor`, replacing M1's fail-fast guard) reading `capabilities.contextWindow`, + Anthropic `model_context_window_exceeded`→compaction trigger (MJ4); **provider-error observability** (typed `provider:error` event/log, m5).
- **Dependencies:** M1 (capabilities schema + fail-fast guard) + M2 (a multi-turn tool loop to exercise round-trip/compaction).
- **Ship:** Anthropic thinking-with-tools works without 400s; caching on; usage accurate; live thinking on the Anthropic lane; a 429 retries instead of killing the turn; small-context models compact instead of 400ing; misconfig is diagnosable.
- **Test:** the **reasoning-round-trip regression** per dialect (assert Anthropic preserves signed thinking, DeepSeek strips `reasoning_content`); per-dialect mapper unit tests; streaming parser tests; **retry test** (429→`Retry-After`→success, not turn-end); **compaction test** (history near `contextWindow` is trimmed, turn continues, **and no orphaned `tool_use`/`tool_result` survives — matched-pair eviction, D8 caution**).
- **Unblocks:** correct, production-grade multi-turn behavior on every provider (latent-bug + robustness closure).

### M5 — External MCP servers (G2 feature parity)
- **Build:** `McpToolClient` port + `RuntimeMcpClient` (embedded MCP client); `resolveRuntimeMcpTools`; lifecycle (open at start / close at stop, fail-soft); merge into `buildLaneTooling` (§5c). If M3 shipped, reconnect on resume.
- **Dependencies:** M2 (the merge point + surface).
- **Ship:** API workers call external MCP tools (`mcp__<server>__<tool>`), gated as `mcp` always-allow.
- **Test:** fake MCP server integration; dead-server fail-soft test.
- **Unblocks:** MCP half of G2.

### M6 — Skills + prompt-template commands (G2 feature parity; largest net-new)
- **Build:** `SkillCatalog` port + `FileSkillCatalog` (generalize `scanSkills`); `Skill` `RuntimeTool` + `SkillBlock` surfacing; skill metadata injection into the DPI append; `expandCommandTemplate` + `expandsSlashTemplates` capability + the `DispatchMessage` hook (§5c).
- **Dependencies:** M1 (**B1/§5h** — the system-prompt slot skill *metadata injection* targets; without it skills cannot auto-surface) + M2 (the merge point + `Bash` for `!`cmd``/skill scripts).
- **Ship:** API workers discover + invoke skills (manual `Skill` tool + metadata-in-prompt) and expand `.md` prompt-template commands. **Not** auto-trigger parity (deliberate v1 cut, §2.2).
- **Test:** skill discovery + metadata-in-prompt + manual-invoke integration; skill-resource path resolution; command-expansion unit tests.
- **Unblocks:** skills/commands half of G2 (completes the "everything" promise, at v1 scope).

**Why this order:** **B1 (§5h) lands in M1 — it is the foundation under instructions**, and both M2's worker behavior and M6's skill-metadata injection depend on the prompt slot it creates. M1 also makes the lane reachable+configured per worker. M2 makes the lane *useful* (tools) and is the gate for the nested-`Task` and MCP/skill merge surfaces. M3 makes it *durable* (production-grade for a persistent orchestrator). M4 makes it *correct + robust* across providers (round-trip, retry, compaction). M5/M6 complete *feature parity*. Q0 (safety + the two live defects) lands ahead of enabling the lane. **The ordering invariant: nothing that depends on worker instructions ships before B1.**

---

## 9. Testing & verification strategy

| Layer | What it asserts | Where |
|-------|-----------------|-------|
| **Conformance (extend)** | The 5 universal invariants stay green with the durable lane (`start` emits `ready+sessionId`; `attach` after resume rehydrates). | `infra/src/__tests__/agent-backend-conformance.ts` |
| **System prompt / DPI delivery (new) — gates B1** | The model client receives a **non-empty `system`** containing the Eos worker protocol + the worker-definition body + injected memory (assert for both dialects); a project/user-scope definition produces byte-identical instructions to the SDK lane. | new `manager` test over the in-process factory |
| **Full-lifecycle integration (new)** | Canonical event sequence end-to-end with a **real (localhost-stub) model + a real system prompt + real built-ins** (not the fake/scripted conformance double): `session started → turn started → delta → message → usage → context → turn ended`; billing/`usage` accounting; error/abort propagation to the FSM. | new `infra`/`manager` integration test |
| **Pricing (new)** | A `costMode:"billed"` profile with no price entry is rejected at load/`POST /api/backends`; `priceFor` for an unknown model returns a loud known-zero (not Opus) + emits a warning (MJ2). | new unit test |
| **Retry / rate-limit (new)** | A 429 with `Retry-After` retries and succeeds rather than ending the turn; a non-retryable 400 ends the turn (MJ3). | new model-client unit test |
| **Context compaction (new)** | History approaching `capabilities.contextWindow` triggers the M1 fail-fast guard (typed error) and, post-M4, compaction that lets the turn continue (MJ4). | new loop/integration test |
| **Per-dialect / provider (new)** | `AnthropicModelClient`/`OpenAIModelClient` mapper round-trips (request shaping, tool_result threading, usage incl. cache fields, stream parsing); keyless empty-key path. | per-client unit tests (mappers already exported) |
| **Reasoning round-trip regression (new) — highest priority** | Anthropic **preserves** signed thinking across tool turns (no 400); DeepSeek/OpenAI **strip** reasoning from history (no 400). Drive both from `ProviderCapabilities`. | new regression suite |
| **Policy-gating (new, cross-lane)** | API-lane `Read/Write/Edit/Bash` get the **same** verdict as SDK for: editRegex deny, Bash command deny, mode `ask`/`allow`, blocked-builtin deny, **rewrite applied** (the §5e fix); orchestrator `Task` absent from the API surface. | new cross-lane gating suite |
| **Tool-behavior conformance (new)** | API-lane built-ins match SDK/CLI semantics (`Read` line numbers, `Edit` unique `old_string`, `Grep` ripgrep, `Bash` timeout/cwd). | new cross-lane tool suite |
| **Durability (new)** | Spawn → persist turn → boot reconcile → SUSPENDED → resume with conversation intact; `/clear` emits `cleared` and resets FSM + store. | new restart integration test |
| **Guard (must stay green)** | No `=== "claude-cli"`-style kind comparison reappears; immutable-`when` DPI rule (recommend adding a guard test — none exists, 04 §4.6). | `backend-kind-literal-guard`; new DPI guard |
| **Repo suites** | `cd manager && npm test`, `cd contracts && npm test` (also `infra`/`core`), `cd app/ui && npm test`, `npm run lint` (dependency direction). | existing |

Self-verification note for the implementing engineer: run `npm run lint` + the per-package suites after each milestone; do **not** run `eos build`/`eos restart` while developing (it restarts the daemon and crashes running workers — CLAUDE.md).

---

## 10. Risks, tradeoffs & decisions needed from the user

Each decision lists a recommended default; the work proceeds on the default unless the user chooses otherwise. The adversarial review's BLOCKER (B1) and all seven MAJORs are now resolved **as concrete design** (§5h, §5b/§5e, §5c, §5f, §5g, §5a; mapped in §12) — they are *not* open decisions. Only **one genuinely-new decision (D8)** arises from the revision; the rest stand.

- **D1 — Durability now (C1) or ephemeral (C2)? [THE biggest decision]** G3 implies a persistent orchestrator on a metered provider; with `sessionStore:"none"` it dies on every daemon restart (verified). **Recommended default: C1 (build `ConversationStore`, M3).** Choose C2 (documented ephemerality) only if the API lane is scoped to short-lived worker tasks and the orchestrator stays on a subscription lane. *This is the single decision that most changes the shape of the deliverable.*
- **D2 — Typed `ProviderCapabilities` in contracts, or loose `params`?** Typed cross-cuts all six dimensions but is what makes G4 (SOLID) real and lets adapters branch on declared facts, not model-name heuristics. **Recommended: typed, scoped to the API lane** (06 §5.2, 04 §5).
- **D3 — Reasoning round-trip representation.** To support Anthropic thinking-with-tools, the neutral `ModelMessage`/`ModelTurn` must carry an opaque signed block to echo back; DeepSeek/OpenAI want it dropped. **Recommended: optional `providerMetadata` + a `reasoningRoundTrip` capability** (carry only when `preserve-signed`). The footgun is real and latent — it only bites once Anthropic thinking is enabled on the API lane (06 §4.4).
- **D4 — Anthropic `streamTurn`: first cut or fast-follow?** Without it the Anthropic API lane has no live thinking (the `createTurn`-only client, verified). **Recommended: M4 (fast-follow), not M1** — it's a distinct SSE parser and not blocking for "any provider works."
- **D5 — Proxy vs raw HTTP.** Eos could point `baseUrl` at a LiteLLM/OpenRouter proxy for instant 100+-provider breadth + `drop_params` + fallbacks, at the cost of an external hop. **Recommended: support it as a `baseUrl` option, don't require it** (it's just another OpenAI-compatible endpoint) (06 §5.4).
- **D6 — Metered-billing consent UX.** Even enabled, a metered pick is rejected without `costMode:"billed"` (verified, `spawn-backend.ts:59-60`). **Recommended: a one-time UI opt-in** that stamps `costMode:"billed"` on the explicit-pick path (`spawn-backend.ts:26`) so a user can consent without hand-editing config.
- **D7 — Non-Claude effort/price: declared or probed?** `ModelCapabilities`/`priceFor` are Claude-only sources (verified). **Recommended: declared in config** (`config.prices` + `ProviderCapabilities`), mirroring LiteLLM's declarative model-map; probing is heavier and deferred (06 §5.5).
- **D8 — Context compaction strategy (NEW, from MJ4): drop-oldest or summarize?** M1 ships a fail-fast guard regardless; M4's real compaction can either **drop** the oldest tool turns (cheap, deterministic, but loses information) or **summarize** them via an extra model call (preserves context, costs tokens + latency on a metered lane). **Recommended default: drop-oldest with a retained summary marker** for v1 (cheap + predictable), with summarize as a per-profile opt-in later. Decision affects only M4's `ContextCompactor` implementation, not the ports. **Implementer caution (either strategy):** evict at whole tool-turn / matched-pair granularity — an orphaned `tool_use` without its `tool_result` is a 400 on Anthropic (see §5g M4 bullet; asserted in the M4 compaction test).
- **Resolved, not open (B1 + the lane parameter):** the system-prompt delivery uses a **new `assembleAppendFor` lane value `"in-process"`** (not a reuse of `"claude-sdk"`), because memory injection is lane-keyed and in-process must inject *all* memory; this is decided in §5h, not deferred to the user. If validation finds a base-harness gap, a `lane/in-process` base fragment is added via the assembly `extra` path (never a `when` gate) — a code detail, not a user decision.
- **Risk — silent capability escape from a wrong tool name.** A built-in named `ShellExec` instead of `Bash` (or `path` instead of `command`) bypasses category verdicts/editRegex silently (05 §4.1). *Mitigation: the shared canonical tool-name enum (§5b) + the cross-lane gating suite (§9).* Not a user decision, but the highest-severity implementation risk.
- **Risk — async env factory must not make `buildLaneTooling` async.** Only credential resolution becomes async; the tool surface stays sync (04 §5). *Mitigation: keep `buildLaneTooling` sync inside the now-async factory.*

---

## 11. Appendix: file-by-file change map

`NEW` = create; `MOD` = modify. One-line purpose each. Grouped by package (dependency order).

### contracts/ (Zod SSOT)
- `MOD contracts/src/backend.ts` — add `AuthRef.kind:"none"`; add `BackendProfile.capabilities?: ProviderCapabilities`.
- `NEW contracts/src/provider-capabilities.ts` — `ProviderCapabilitiesSchema` (wire/reasoning/cache/tokens/structuredOutput/round-trip).
- `MOD contracts/src/worker-definition.ts` — add `backendProfile?: string`.
- `NEW contracts/src/builtin-tools.ts` — the single canonical tool-name enum (referenced by permission-mode/tool-scope/registry).
- `MOD contracts/src/http.ts` — add `POST /api/backends` to ROUTES.
- `MOD contracts/src/canonical.ts` — (only if `SkillBlock`/usage need extension; otherwise unchanged — `BackendKind` stays the 5 kinds).

### core/ (pure domain · ports · use-cases)
- `MOD core/src/ports/AgentBackend.ts` — `BackendDescriptor.sessionStore += "eos-conversation"`; `BackendLaunchOptions.baseUrl?`; `AgentCapabilities.expandsSlashTemplates?`; allow per-kind `streamingThinking`/`resumable`.
- `MOD core/src/ports/BackendDefaults.ts` — `ResolvedBackend.auth?: AuthRef`.
- `MOD core/src/ports/ModelClient.ts` — `ModelTurn.providerMetadata?`; allow `ModelMessage` to carry a signed reasoning block.
- `NEW core/src/ports/ConversationStore.ts` — persist/load/delete in-process conversations.
- `NEW core/src/ports/BuiltinToolRegistry.ts` — Open/Closed assembler of the built-in `RuntimeTool` map.
- `NEW core/src/ports/FileSystem.ts` · `NEW core/src/ports/ProcessRunner.ts` — DIP seams for the built-ins.
- `NEW core/src/ports/SkillCatalog.ts` — `listSkills`/`loadBody` (returns `{body, dir}` for resource paths, MJ6).
- `NEW core/src/ports/McpToolClient.ts` — embedded MCP client seam (connect/list/call/close).
- `NEW core/src/ports/ContextCompactor.ts` — drop/summarize oldest turns near `contextWindow` (MJ4).
- `NEW core/src/domain/command-template.ts` — `expandCommandTemplate(md,args,ctx)`.
- `MOD core/src/ports/IdGenerator.ts` — add `newSessionId(): string` (MJ7 durability sessionId source).
- `MOD core/src/use-cases/ToolRuntime.ts` — widen `ToolGate.decide` return with `updatedInput?` + apply in `executeGated` (Q0a); add an optional context-window pre-flight guard/`ContextCompactor` hook in the loop deps (MJ4).
- `MOD core/src/use-cases/SpawnWorker.ts` — forward `backendOptions.{auth,baseUrl,params}` (today `{spec}` only).
- `MOD core/src/domain/worker-definition-resolution.ts` — carry `backendProfile` through `applyWorkerDefinitionDefaults`.
- `MOD core/src/use-cases/ProcessAgentSignal.ts` — (no logic change; it already persists `sessionId` on `ready` and resets on `cleared` — relied upon by §5f).
- `(unchanged, relied upon) core/src/services/SqlBackedBackendResolver.ts` — already honors `explicitProfileName` first; `auth` flows via `profile()`.

### infra/ (Node adapters)
- `NEW infra/src/tools/builtins/{read,write,edit,multi-edit,notebook-edit,bash,bash-output,kill-shell,glob,grep,ls,web-fetch,web-search,todo-write,task,exit-plan-mode}.ts` — the ~16 bare-named `RuntimeTool`s.
- `NEW infra/src/tools/builtins/registry.ts` — assembles them into the `BuiltinToolRegistry`.
- `NEW infra/src/fs/NodeFileSystem.ts` · `NEW infra/src/process/NodeProcessRunner.ts` — port implementations.
- `NEW infra/src/conversation/JsonlConversationStore.ts` — JSONL persistence under `~/.eos/conversations`.
- `NEW infra/src/mcp/RuntimeMcpClient.ts` — embedded `@modelcontextprotocol/sdk` client + connection registry.
- `NEW infra/src/skills/FileSkillCatalog.ts` — generalizes `scanSkills` out of the route.
- `MOD infra/src/backends/InProcessBackend.ts` — async env factory carrying `system` (B1); `createInProcessBackend(kind, envFactory, deps?:{store,ids})` (MJ7); `LiveSession.sessionId` via `deps.ids.newSessionId()`; emit `ready+sessionId` (`start`) + `cleared` (`clearContext`); `deps.store?.save` at the `kickTurn` `.then` save point; rehydrate via `deps.store?.load(resume)`; **kind-aware `sessionFor` `CAPS`** so session caps vary per provider (m1); `attach` rehydrate-or-document-absence (MJ7); per-kind descriptor caps; (descriptors enabled via config, not hardcoded flip).
- `NEW infra/src/conversation/ContextCompactor` adapter (or fold into the loop) — drop-oldest-with-summary near `contextWindow` (MJ4, D8).
- `MOD infra/src/id/RandomIdGenerator.ts` — implement `newSessionId` (`"s-"+rand(8)`) (MJ7).
- `MOD infra/src/backends/AnthropicModelClient.ts` — accept+send `system` already (B1, no change beyond wiring); add `streamTurn` (separate parser); `cache_control` injection; preserve signed thinking on round-trip; capability-driven `max_tokens`; map `model_context_window_exceeded`→compaction trigger (MJ4); `withRetry` on 429/5xx (MJ3).
- `MOD infra/src/backends/OpenAIModelClient.ts` — read `prompt_tokens_details.cached_tokens`; tolerate empty/keyless `Authorization` (no header when key empty); robust streamed-tool-delta tolerance; `withRetry` on 429/5xx (MJ3).
- `MOD infra/src/auth/SubscriptionAuthResolver.ts` — add `writeKeychainSecret` companion; handle `AuthRef.kind:"none"` (already returns `scheme:"none"`).

### manager/ (composition root + entrypoints)
- `MOD manager/container.ts` — async in-process env factories that **(B1)** assemble `system = assembleAppendFor(spec.backendOptions.spec, id, "in-process")` and pass it to the model clients, resolve `auth/baseUrl/params` via `authResolver` (drop `process.env` reads), merge built-ins + external-MCP RuntimeTools + `Skill` tool into `buildLaneTooling`, and construct the `Task` closure (MJ5); pass `{store, ids}` into `createInProcessBackend` (MJ7); map `p.auth` at `backendDefaults.profile()`; **fix `priceFor` unknown-model fallback** to loud-known-zero + warning (MJ2/Q0c); inject `ConversationStore`/`BuiltinToolRegistry`/`SkillCatalog`/`ContextCompactor`/MCP-resolver; register `POST /api/backends` deps.
- `MOD manager/backends/PolicyToolGate.ts` — propagate `updatedInput`; thread `agentId` for nested-Task isolation.
- `MOD manager/commands/handlers/spawn-worker.ts` — pass resolved `rb` into `spawnWorker` (`backendOptions.{auth,baseUrl,params}`).
- `MOD manager/routes/orchestrators.ts` — same `rb` threading for the orchestrator path.
- `MOD manager/routes/uiConfig.ts` — expose `config.backends` (profiles) for the model/provider picker.
- `NEW manager/routes/backends.ts` — `POST /api/backends` (**normalize baseUrl to origin-only (MJ1); require a price for `costMode:"billed"` (MJ2);** Keychain write + profile write + `reloadConfig`).
- `MOD manager/routes/dispatch-deps.ts` / `core` `DispatchMessage` — command-expander hook gated on `expandsSlashTemplates`.
- `MOD manager/shared/config.ts` — example non-Claude `DEFAULT_BACKENDS` + non-Claude `prices`; default `ProviderCapabilities` per kind.
- `MOD manager/shared/spawn-backend.ts` — (no logic change; metered `costMode` opt-in surfaced via the UI per D6).

### tests (new)
- `NEW manager/__tests__/api-lane-system-prompt.test.ts` — **B1/N1**: the in-process factory delivers a non-empty `system` (protocol + definition body + base fragment), AND a **behavioral parity** check — the API-lane agent uses its instructions/tools to the same observable outcome as the SDK lane on the same definition (esp. the raw `anthropic-api` profile).
- `NEW infra/src/__tests__/builtin-tool-conformance.test.ts` — cross-lane tool-behavior parity (incl. the `Task` nested-loop, MJ5).
- `NEW manager/__tests__/api-lane-gating.test.ts` — cross-lane policy-gating incl. rewrite-applied (Q0a) + orchestrator-`Task` absent + sub-agent control-tool isolation.
- `NEW infra/src/__tests__/reasoning-round-trip.test.ts` — the per-dialect regression (§5g / D3 / 06 §4.4).
- `NEW infra/src/__tests__/provider-pricing.test.ts` — billed-profile-needs-price + non-Opus unknown fallback (MJ2/Q0c).
- `NEW infra/src/__tests__/model-client-retry.test.ts` — 429/`Retry-After` retries; non-retryable ends the turn (MJ3).
- `NEW manager/__tests__/api-lane-lifecycle.test.ts` — full canonical event sequence (real localhost-stub model + real system prompt + real built-ins) + durability/restart + context compaction (MJ4).
- `NEW infra/src/__tests__/baseurl-compose.test.ts` — origin-only → exact `<origin>/v1/...` (MJ1).
- `NEW infra/src/__tests__/anthropic-stream.test.ts` · `openai-compat.test.ts` — dialect parsers.
- `NEW core/__tests__/dpi-immutable-when-guard.test.ts` — enforce the immutable-`when` rule (currently discipline-only).

---

## 12. Review resolution (REVIEW.md → this plan)

Every BLOCKER, MAJOR, and MINOR from the adversarial review, mapped to its concrete resolution and the plan section that now carries it. Each was re-verified against the code before being designed (not taken on faith). **Round 2 of the review returned implementation-ready (0 BLOCKER, 0 MAJOR)**; its two MINOR residuals (N1, N2) and the D8 implementation caution are folded below and marked resolved-in-plan — this is the final pass.

| Finding | Sev | Verified? | Resolution in this plan | Lives in |
|---------|-----|-----------|-------------------------|----------|
| **B1** — API lane never receives a system prompt / DPI | BLOCKER | ✔ (`container.ts:761,771`; `InProcessBackend.ts:140`; `:804`) | Async env factory assembles `system = assembleAppendFor(spec.backendOptions.spec, id, "in-process")` (new lane value → `selectInjectableMemory` injects *all* memory → a *complete* prompt) and passes it to the model clients' existing `system` field. Foundational → **M1**, before tools/skills. Conformance claim reframed as shape-only. | §5h, §1 (gap 0), §3.1, §4.1, M1, §9 |
| **MJ1** — `baseUrl` `/v1` double-join; example wrong | MAJOR | ✔ (`OpenAIModelClient.ts:29,41,67`) | Convention = **origin-only**; client owns the version path; `POST /api/backends` normalizes (strips trailing `/v1`); §7.1/§2.1 examples corrected; M1 test asserts composed URL. | §7.1, §7.2, Q0b, M1 |
| **MJ2** — unknown models bill at Opus rates | MAJOR | ✔ (`container.ts:242`) | `priceFor` unknown-model fallback → loud known-zero + warning (Q0c); **require a price for every `costMode:"billed"` profile** at load/write. | §5a, §7.2, Q0c, M1 |
| **MJ3** — no retry/backoff; one 429 kills the turn | MAJOR | ✔ (`OpenAIModelClient.ts:49-51`; `ToolRuntime.ts:83-86`) | `withRetry` (bounded exp backoff, honors `Retry-After`, 429/500/502/503/529) inside both clients, distinct from the hard error; capability-gated knobs. | §5g, M4 |
| **MJ4** — no compaction; `contextWindow` declared-but-unused | MAJOR | ✔ (`ToolRuntime.ts:93,99`; `InProcessBackend.ts:80`) | **M1**: fail-fast pre-flight guard (typed `context_window_exceeded`). **M4**: `ContextCompactor` (drop-oldest+summary, reads `contextWindow`) + Anthropic `model_context_window_exceeded`→compaction trigger. No field ships unread. | §5g, §5a, M1, M4, D8 |
| **MJ5** — `Task` subagent hand-waved | MAJOR | ✔ (`ToolRuntime.ts:16-19`) | `Task` = a closure built by `buildLaneTooling` over the env-factory ingredients → child surface w/o control tools, child DPI prompt via `assembleAppendFor(childSpec,"in-process")` (`subagent_type`→built-in def), child `emit` re-tag, depth cap, shared `signal`, `agentId` gate isolation. | §5b, §5e, M2 |
| **MJ6** — skills rest on the missing prompt slot; no resource paths | MAJOR | ✔ (depends on B1; 03 §3.2 #4) | Metadata injection now targets the **§5h** slot (created by B1); `SkillCatalog.loadBody`→`{body, dir}` for `Bash`/`Read` resource access; G2 states v1 = discovery + metadata + manual-invoke (not auto-trigger). | §5c, §4.4, M6 |
| **MJ7** — durability injection seam / sessionId / `attach` hazard | MAJOR | ✔ (`InProcessBackend.ts:25-29,66,143-145`) | `createInProcessBackend(kind, envFactory, {store, ids})`; `sessionId = ids.newSessionId()` (new `IdGenerator` method); save at the `kickTurn` `.then`; resume via `store.load`; `attach` documented (resume goes through `start`) + optional lazy-rehydrate. | §5f, §6, M3 |
| **m1** — `streamingThinking` per-kind needs `sessionFor`/`CAPS` to vary | MINOR | ✔ (`InProcessBackend.ts:44-51,89`) | Make `sessionFor`'s returned `CAPS` kind-aware, not just the descriptor. | §5f, M1, §11 |
| **m2** — Anthropic `createTurn` non-cancellable mid-request until M4 | MINOR | ✔ (`AnthropicModelClient.ts:33-59`) | Documented as an M1–M3 limitation; resolved when `streamTurn` lands (M4). | M1 (limitations), §5g |
| **m3** — profileless/ad-hoc metered picks get no creds | MINOR | ✔ (`SqlBackedBackendResolver.ts:54-56`) | Require metered selection via a **named profile**; documented limitation otherwise. | M1 (limitations) |
| **m4** — keep Anthropic *thinking* OFF until M4 | MINOR | ✔ (`AnthropicModelClient.ts:69-73`) | Explicit ⚠ note on the `anthropic-billed` example; round-trip carrier lands M4. | §7.1 |
| **m5** — no provider-error observability | MINOR | ✔ | Typed `provider:error` event/structured log on 400/refusal/missing-price paths. | §5g, M4 |
| **m6** — conformance pass is shallow; don't lean on it | MINOR | ✔ (`agent-backend-conformance.ts`) | §1/§3.1 reworded ("shape-conformant, not production-ready"); the full-lifecycle test now runs a real localhost-stub model + real system prompt + real built-ins. | §1, §3.1, §9 |
| **N1** (round 2) — B1 delivers a prompt; base-harness *sufficiency* asserted, not proven (esp. raw `anthropic-api`) | MINOR | ✔ (`ClaudeSdkBackend.ts:305` — SDK has `claude_code` preset, in-process has none) | **Pre-author** a `lane/in-process` base-harness fragment (not "if a gap appears") via the assembly `extra`/lane-param path; **strengthen the M1 test to a behavioral parity check** (the agent actually uses its instructions/tools to the SDK lane's outcome), not just "system non-empty". | §5h (step 3 + Test), M1, §9 |
| **N2** (round 2) — `Task` closure ↔ `buildLaneTooling` sync/creds coherence | MINOR | ✔ (`container.ts:743` — sync, spec-only) | §5e step 3 states the `Task` closure is built **inside the async-factory scope after `authResolver.resolve`** (or receives resolved creds + dialect builder as params), so the child builds its model client from resolved creds; `buildLaneTooling` stays sync. | §5e, M2 |
| **D8 caution** (round 2) — compaction must evict matched tool-pairs | (impl note) | ✔ (Anthropic 400 on orphaned `tool_use`) | Compaction evicts at whole tool-turn / matched-pair granularity; the M4 compaction test asserts no orphaned `tool_use`/`tool_result` survives. | §5g (M4 bullet), §10 D8, M4 |

### G1–G4 coverage — now closed (post-revision)

| Goal | Status | What closes it |
|------|--------|----------------|
| **G1** — any provider by key + local by localhost URL | **Closed** | Threading §5d + keyless `AuthRef "none"` + **baseUrl origin-only (MJ1)** + **accurate pricing (MJ2)** + **retry (MJ3)** + **small-context compaction (MJ4)**. *Qualifier (explicit, §2.2): models with no native tool-calling (`supportsTools:false`) are out of v1 scope — "any provider" means any of the two-dialect ecosystem.* |
| **G2** — full SDK/CLI feature set (built-ins, MCP, skills) | **Closed at v1 scope** | Built-ins (M2) **+ B1 instructions (§5h)** so the agent uses its tools rather than "ignores them" + **`Task` fully designed (MJ5)** + MCP (M5) + skills (M6, discovery+metadata+manual-invoke) + **compaction parity (MJ4)**. Auto-trigger skills are the one stated v1 cut. |
| **G3** — any model on orchestrator + all worker scopes, in sync, surviving restart | **Closed** | `backendProfile` on every scope + resolver inheritance (§5d) + **B1 (§5h): a definition is the *same agent* on any provider** (byte-identical DPI) + **durability (MJ7/§5f) survives restart** + **correct cross-provider cost (MJ2)**. |
| **G4** — modular, configurable, SOLID | **Closed** | Extension points (§4.6: provider=config entry, tool=registry entry, no new class) + capability-not-kind discipline + **no declared-but-unused field** (`contextWindow` now consumed, MJ4) + **B1 closes the "structure missing" DPI hole** + the DPI-immutable-`when` guard test (§9). |

*Bottom line: round 2 returned **implementation-ready (0 BLOCKER, 0 MAJOR)**. The BLOCKER and all 7 MAJORs are resolved as concrete, code-verified design; the two round-2 MINOR residuals (N1 base-harness pre-authoring + behavioral parity test; N2 `Task` creds coherence) and the D8 matched-pair compaction caution are now folded. The one open decision is D8 (compaction strategy, recommended default given) — non-blocking. The architecture the review judged sound is unchanged; the gaps it found are filled. This is the final pass.*

---

*End of plan. Findings 01–06 and REVIEW.md are the read-only inputs; this document is the synthesized, verified, revised, implementation-ready design.*
