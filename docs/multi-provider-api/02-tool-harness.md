# Dimension 02 — Tool & Feature Harness (the agentic tool-use loop + built-in tools)

> Scope: when an API agent starts "empty", Eos must supply (a) the agentic
> tool-use loop and (b) every built-in tool the SDK/CLI give for free. This file
> maps what already exists, what is stubbed/disabled, what is missing, and the
> design seams for the multi-provider API lane.
>
> Sibling-file status: this is the first file written to `docs/multi-provider-api/`
> (no siblings present at write time). Cross-dimension seams are flagged inline.

---

## 1. Summary

The load-bearing facts (each grounded below):

1. **The provider-agnostic agent loop ALREADY EXISTS and is complete.**
   `core/src/use-cases/ToolRuntime.ts` (`runTurn`, `ToolRuntime.ts:37`) is the
   Eos-hosted loop: call model → if tool calls, gate + execute each → feed
   results back → repeat until the model ends the turn. It is pure, streams via
   `ModelClient.streamTurn`, gates EVERY call through one chokepoint
   (`executeGated`, `ToolRuntime.ts:110`), and is conformance-tested. **This does
   NOT need to be built.**

2. **The in-process lane is fully wired and conformance-tested — but DISABLED and
   tool-starved.** `InProcessBackend` (`infra/src/backends/InProcessBackend.ts`)
   drives `runTurn` per turn; it is registered for `anthropic-api`/`openai`/`codex`
   in `manager/container.ts:758-777` with real `AnthropicModelClient` /
   `OpenAIModelClient` adapters and a policy gate. All three descriptors are
   `enabled: false` (`InProcessBackend.ts:55-57`).

3. **The tool MAP the API model receives today contains ONLY Eos control tools
   (`mcp__orchestrator__*` / `mcp__worker__*`), NOT the built-in
   filesystem/shell tools.** `buildLaneTooling` (`container.ts:743-754`) projects
   `orchestratorDefs/workerDefs/peerDefs/workflowWorkerDefs` via `toRuntimeTool`
   and nothing else. **An API worker today can `spawn_worker` / `message_worker`
   but CANNOT Read, Write, Edit, Bash, Glob, or Grep.** This is the core gap.

4. **The SDK/CLI lanes get Write/Edit/Read/Bash/Glob/Grep "for free" from the
   provider.** The claude-sdk lane boots the SDK `systemPrompt` preset
   `claude_code` (which ships the built-in tools) and merely sets
   `allowedTools: []` (`SdkToolHost.ts:63`) + `disallowedTools`
   (`tool-scope.ts:57`) so every call routes through `canUseTool`. The claude-cli
   lane gets them from the bundled `claude` TUI binary. **Neither path has any
   reusable built-in-tool implementation Eos can lift for the API lane.**

5. **Zero built-in-tool implementations exist anywhere in the repo.** The only
   `RuntimeTool` producer is `toRuntimeTool` (`projections.ts:59`), which wraps
   Eos `ToolDefinition`s (control tools). So the API lane must author ~16
   built-in tools (Read/Write/Edit/MultiEdit/NotebookEdit/Bash/BashOutput/
   KillShell/Glob/Grep/LS/WebFetch/WebSearch/TodoWrite/Task/ExitPlanMode) — using
   the SAME canonical names + input field names so the existing policy engine,
   `editRegex`, and permission-mode tables apply unchanged.

**Headline: the tool-execution path (ToolRuntime) exists and is reusable; what's
missing is the built-in tools to feed it — ~16 to port.**

---

## 2. Current state (what exists today)

### 2.1 The agentic loop — `ToolRuntime` (exists, complete)

`core/src/use-cases/ToolRuntime.ts`. Pure, no Node imports. Drives a `ModelClient`.

Ports it depends on:

```ts
// ToolRuntime.ts:16
export interface RuntimeTool { name: string; execute(input: Record<string, unknown>): Promise<string>; }
// ToolRuntime.ts:21
export interface ToolGate { decide(toolName, input): Promise<{ allow: boolean; message?: string }>; }
// ToolRuntime.ts:26
export interface ToolRuntimeDeps {
  model: ModelClient; tools: Map<string, RuntimeTool>; gate: ToolGate;
  emit(event: AgentEvent): void; maxIterations?: number; signal?: { aborted: boolean };
}
export async function runTurn(deps, conversation: ModelMessage[]): Promise<ModelMessage[]> // :37
```

Loop behavior (`runTurn`, `ToolRuntime.ts:37-105`):
- Emits `turn:started`, then loops up to `maxIterations ?? 50` (`:39`, runaway guard → `turn:aborted reason=max_iterations` at `:103`).
- Cooperative cancel: checks `deps.signal.aborted` between round-trips (`:43`) → `turn:aborted reason=interrupted`.
- Prefers `model.streamTurn` (live `delta` events, reasoning+text) and falls back to `createTurn` (`:56-62`). Live block close-out + durable `message` emission at `:69-72`.
- Splits usage into a summed billing `usage` event and a latest-wins `context` event (`:73-81`) via `contextTokensOf` — same split the SDK lane uses.
- Stop condition: `turn.toolCalls.length === 0` → `turn:ended` (`:88-91`). Otherwise pushes the assistant tool-call message and **executes each call SEQUENTIALLY** (`for (const call of turn.toolCalls)`, `:95-100`), emitting a `tool_call` message, then a `tool_result` message, and pushing `{ role: "tool", content: { callId, result, isError } }` back onto the conversation.

Single gate chokepoint (`executeGated`, `ToolRuntime.ts:110-131`): `gate.decide` → if denied, the message becomes an **error tool_result** (`:121`); unknown tool → `unknown tool: <name>` error result (`:124`); a thrown handler → error result (`:129`). Fail-closed: a missing gate / unknown tool / throw is never a silent skip.

### 2.2 The model seam — `ModelClient` (exists)

`core/src/ports/ModelClient.ts`. Minimal, backend-agnostic:

```ts
export interface ModelToolCall { callId: string; name: string; input: Record<string, unknown>; }
export interface ModelMessage { role: "user"|"assistant"|"tool"; content: unknown; } // backend-shaped
export interface ModelTurn {
  text?; reasoning?; toolCalls: ModelToolCall[];
  stopReason: "end_turn"|"tool_use"|"max_tokens"|"error"; usage?; error?;
}
export interface ModelClient {
  createTurn(messages): Promise<ModelTurn>;        // :38
  streamTurn?(messages, cb): Promise<ModelTurn>;   // :42 optional (ISP)
}
```

Adapters (both pure transport; tool schema fixed at construction):
- `infra/src/backends/AnthropicModelClient.ts` — `createTurn` only (NO `streamTurn`). Maps `ModelMessage[]` → Messages API; `tool` role → `tool_result` block (`:65-68`), assistant tool-call array → `tool_use` blocks (`:69-74`); parses `text`/`thinking`/`tool_use` back (`parseAnthropicResponse:84`). **anthropic-api therefore has no live thinking** — `runTurn` falls back to `createTurn`.
- `infra/src/backends/OpenAIModelClient.ts` — `createTurn` (`:31`) AND `streamTurn` (`:55`). Covers OpenAI / DeepSeek / Kimi / Codex-via-API / any `baseUrl`. `streamTurn` drains SSE (`parseOpenAIStream:144`): streams `content`+`reasoning_content` deltas, buffers tool-call fragments by `index` and JSON-parses once complete; an aborted stream returns `stopReason:"error", error:"aborted"` (`:195`).

Both can return **multiple `toolCalls`** in one `ModelTurn` (parallel tool calls) — but `runTurn` executes them serially (see §4.4).

### 2.3 The in-process backend — `InProcessBackend` (exists, wired, DISABLED)

`infra/src/backends/InProcessBackend.ts`. Holds a live in-memory session
registry keyed by `workerId`; each `sendMessage` kicks a `runTurn` (`kickTurn`,
`:73-84`). Capabilities (`CAPS`, `:44-51`): `interrupt:true, keystroke:false,
rewind:false, runtimeModelSwitch:false, runtimePermissionSwitch:false,
contextClear:true`. `interrupt` sets `signal.aborted` (`:97-101`); `clearContext`
drops the message buffer (`:104-110`); `setModel` no-ops (`:113`).

Env factory seam (this is where tools + model + gate are injected):

```ts
// InProcessBackend.ts:25
export interface InProcessEnv { model: ModelClient; tools: Map<string, RuntimeTool>; gate: ToolGate; }
export type InProcessEnvFactory = (spec: AgentLaunchSpec) => InProcessEnv;   // :30
```

Descriptors (`IN_PROCESS_DESCRIPTORS`, `:54-58`) — **all `enabled: false`,
`sessionStore: "none"`**: `anthropic-api` (models `claude`), `openai`/`codex`
(models `openai-compatible`). Run through the shared conformance suite (§2.7).

### 2.4 The wiring — `manager/container.ts` (exists; control-tools only)

```ts
// container.ts:743 — projects ONLY Eos control tools onto the runtime
const buildLaneTooling = (spec) => {
  const defs = role==="workflow-worker" ? workflowWorkerDefs
    : spec.isOrchestrator ? orchestratorDefs
    : [...workerDefs, ...(collaborate ? peerDefs : [])];
  const items = defs.map(d => ({ name: prefixedToolName(server,d.name), description, schema: toolJsonSchema(d), execute: toRuntimeTool(d,ctx).execute }));
  const tools = new Map(items.map(i => [i.name, { name:i.name, execute:i.execute }]));
  return { items, tools };
};
const anthropicBackend = createInProcessBackend("anthropic-api", (spec) => {  // :758
  const { items, tools } = buildLaneTooling(spec);
  return { model: createAnthropicModelClient({ ..., tools: items.map(i => ({ name, description, input_schema })) }), tools, gate: makePolicyToolGate(spec.workerId, sdkPolicy) };
});
const openaiEnv = (spec) => { ... createOpenAIModelClient({ ..., tools: items.map(i => ({ name, description, parameters })) }) ... };  // :768
const openaiBackend = createInProcessBackend("openai", openaiEnv);   // :776
const codexBackend  = createInProcessBackend("codex",  openaiEnv);   // :777
const backendMap = new Map([["claude-cli",…],["anthropic-api",anthropicBackend],["openai",…],["codex",…]]); // :867
```

`items` is the **tool SCHEMA offered to the model**; `tools` is the **dispatch
map** `runTurn` looks up. Both today = control tools only. The built-in
filesystem/shell tools appear in NEITHER, so the API model is never told they
exist and `executeGated` would answer `unknown tool: Write` if one were emitted.

`makeToolContext` (`container.ts:734-739`) gives every projected tool a
daemon-loopback `api()` (`ctx.api → daemonApi(sdkDaemonUrl,…)`) — correct for
control tools (they mutate daemon state) but NOT a natural fit for filesystem
tools that must touch `spec.cwd` directly (see §4.2).

### 2.5 The projection — `toRuntimeTool` (exists; for Eos tools only)

`manager/tools/projections.ts:59-67` is the one production `RuntimeTool` factory:

```ts
export function toRuntimeTool(def: ToolDefinition, ctx: ToolContext): RuntimeTool {
  return { name: def.name, async execute(input) {
    const res = await def.handler(ctx, input);
    return typeof res === "string" ? res : JSON.stringify(res, null, 2);
  }};
}
```

It is one of three transport projections of a single `ToolDefinition`
(`manager/tools/types.ts:27`): `toMcpModule` (claude-cli MCP subprocess),
`toSdkTool` (`SdkToolHost.ts:15`, claude-sdk), `toRuntimeTool` (API lane). The
adapter pattern is in place — but only Eos control tools are defined as
`ToolDefinition`s; there is no `ToolDefinition` (nor any standalone `RuntimeTool`)
for any built-in.

### 2.6 The gate — `PolicyToolGate` + `classifyTool` (exists; built-ins inherit it free)

`manager/backends/PolicyToolGate.ts:11`:

```ts
export function makePolicyToolGate(workerId, policy: PolicyDecider): ToolGate {
  return { async decide(toolName, input) {
    if (isBlockedBuiltinTool(toolName)) return { allow:false, message: blockedBuiltinToolMessage(toolName) };
    const d = await policy.decide({ workerId, toolName, input });
    return d.behavior==="allow" ? { allow:true } : { allow:false, message:d.message };
  }};
}
```

This is the **same `PolicyGatewayService` the claude-cli (hook) and claude-sdk
(`canUseTool`) lanes use** — one decision engine, three lanes. Policy keys on the
**bare tool name + input fields**:
- `core/src/domain/permission-mode.ts:28-31` — `FILE_EDIT_TOOLS={Edit,Write,MultiEdit,NotebookEdit}`, `SHELL_TOOLS={Bash,BashOutput,KillBash,KillShell}`, `READ_TOOLS={Read,Glob,Grep,LS}`, `NETWORK_TOOLS={WebFetch,WebSearch}`.
- `classifyTool` (`permission-mode.ts:56-73`): `mcp__*`→`mcp` (always-allow); file-edit tools inspect `input.file_path`/`input.notebook_path` for plan-dir carve-out (`:63-66`); else `shell`/`read`/`network`/`other`.
- `policy.example.yaml` rules match on `tool: Bash, command: "<regex>"` etc. (`:12-34`) — i.e. on the **`command`/`file_path`/etc. input field names**.

**Design constraint (critical):** API-lane built-ins MUST use these exact names
(`Bash`, `Write`, …) and exact input field names (`command`, `file_path`,
`pattern`, …) so the entire policy/permission-mode/editRegex stack works
unchanged. This is the dim-5 seam: each built-in call already hits policy via
`makePolicyToolGate` → no new permission wiring is needed, only canonical naming.

### 2.7 Conformance + fakes (exists)

- `infra/src/__tests__/agent-backend-conformance.ts` asserts 5 universal
  invariants on every backend: `start` returns a session (handle/caps/isAlive) +
  fires `onSpawn` (`:39`); `sendMessage` is ok-shaped (`:53`); `attach`
  reconstructs an alive session (`:63`); `stop` is idempotent → `isAlive=false`
  (`:72`); `onExit` fires on exit (`:81`). It does NOT assert tool behavior.
- `InProcessBackend` runs through it with a **fake `ModelClient`** that cycles
  scripted `ModelTurn`s and an always-allow gate (`InProcessBackend.test.ts`) — so
  the loop is verifiable with no API key / no billing.
- `FakeAgentBackend` (`infra/src/backends/FakeAgentBackend.ts`) records
  messages/keystrokes/interrupts; the test double for the daemon/use-cases.

### 2.8 How the other lanes provide tools (reference / contrast)

- **claude-sdk** (`SdkToolHost.ts`): projects Eos tools onto an in-process SDK
  MCP server, returns `allowedTools: []` (`:63`, so nothing bypasses
  `canUseTool`). Built-ins come from the SDK `systemPrompt` preset `claude_code`;
  `disallowedTools: disallowedBuiltinToolsFor(isOrchestrator)`
  (`ClaudeSdkBackend.ts ~284`, from `tool-scope.ts:57`) strips the blocked set.
  `canUseTool` (`SdkPermissionBridge.makeCanUseTool`) routes every call —
  built-in AND `mcp__*` — to the shared policy. **The SDK owns the agentic loop;
  Eos only feeds input + gates.**
- **claude-cli** (`manager/backends/ClaudeCliBackend.ts`): a PTY child running the
  bundled `claude` binary; built-ins are the TUI's. Eos sees them only as
  policy decisions + transcript events. No reusable tool code.

---

## 3. Gaps & missing pieces (what the API lane needs that isn't there)

### 3.1 Built-in tool implementations — NONE exist (the central gap)

Full inventory of built-ins the SDK/CLI expose that an API worker must get from
Eos. "Eos cite" = where Eos already references the canonical name (proof the
policy stack expects it).

| Tool | Category (`permission-mode.ts`) | Canonical input fields | Eos cite |
|------|------|------|------|
| `Read` | read | `file_path`, `offset?`, `limit?` | policy.example.yaml:24 |
| `Write` | fileEdit | `file_path`, `content` | policy.example.yaml:25 |
| `Edit` | fileEdit | `file_path`, `old_string`, `new_string`, `replace_all?` | policy.example.yaml:26 |
| `MultiEdit` | fileEdit | `file_path`, `edits[]` | permission-mode.ts:28 |
| `NotebookEdit` | fileEdit | `notebook_path`, `new_source`, … | policy.example.yaml:31 |
| `Bash` | shell | `command`, `timeout?`, `run_in_background?` | policy.example.yaml:12,23 |
| `BashOutput` | shell | `bash_id` | permission-mode.ts:29 |
| `KillBash`/`KillShell` | shell | `shell_id` | permission-mode.ts:29 |
| `Glob` | read | `pattern`, `path?` | policy.example.yaml:27 |
| `Grep` | read | `pattern`, `path?`, `output_mode?`, … | policy.example.yaml:28 |
| `LS` | read | `path` | permission-mode.ts:30 |
| `WebFetch` | network | `url`, `prompt` | policy.example.yaml:29 |
| `WebSearch` | network | `query` | policy.example.yaml:30 |
| `TodoWrite` | other | `todos[]` | policy.example.yaml:34 |
| `Task`/`Agent` | other | `description`, `prompt`, `subagent_type` | policy.example.yaml:32,33 |
| `ExitPlanMode` | other | `plan` | *(INFERENCE — standard Claude Code built-in; not cited in Eos)* |
| `Skill`/`SlashCommand` | — | — | *(dim 3 — skills/slash-commands)* |

Platform-blocked (do NOT reimplement): `AskUserQuestion`, `Workflow`
(`tool-scope.ts:26`) — already hard-denied by `makePolicyToolGate` via
`isBlockedBuiltinTool`. Orchestrators additionally lose `Task`
(`tool-scope.ts:52`).

**Count to port for a worker: ~16** (treating KillBash/KillShell and Task/Agent
as one each; excluding the 2 blocked and Skill which is dim 3).

There is **no single canonical enum** of these names — they live as four category
`Set`s in `permission-mode.ts:28-31`, the blocked lists in `tool-scope.ts`, and
`policy.example.yaml`. Porting them is a good moment to introduce one.

### 3.2 Wiring gap — built-ins reach neither the schema nor the dispatch map

`buildLaneTooling` (`container.ts:743`) must merge built-ins into BOTH `items`
(model schema) and `tools` (dispatch map). Today it merges neither.

### 3.3 Behavior-parity gap

The SDK/CLI built-ins have specific semantics workers rely on: `Read` returns
`cat -n` line numbers; `Edit` requires a unique `old_string`; `Bash` enforces
timeouts and a sandbox; `Grep` wraps ripgrep. Reimplementations must match, or
the SAME worker definition behaves differently across lanes. No shared
behavior spec / cross-lane tool conformance suite exists today
(`agent-backend-conformance.ts` tests lifecycle, not tools).

### 3.4 `Task` (subagent) has no API-lane meaning

Workers keep `Task` on CLI/SDK (`tool-scope.ts:48-51`) to spawn
Explore/Plan/general-purpose subagents — a provider primitive the API model
does not have. On the API lane `Task` must be reimplemented as a nested
`runTurn`/`InProcessBackend` session (a sub-agent loop) or routed to Eos
spawning. Overlaps **dim 1** (backend lifecycle/selection).

### 3.5 Lane limitations (not tool-harness gaps, but adjacent)

- `anthropic-api` has no `streamTurn` → no live thinking (dim 4 model/config).
- `sessionStore:"none"` → in-process sessions don't survive a daemon restart;
  boot must reconcile orphaned rows (`InProcessBackend.ts:9-10`; reconciliation
  is **dim 1**). INFERENCE: not yet implemented.

---

## 4. Design implications & options

### 4.1 The loop is settled — reuse `ToolRuntime` as-is

No new loop. `runTurn` already does model→dispatch→feed-back→repeat with
streaming, abort, max-iterations, and a fail-closed gate. The work is supplying
its `tools: Map<string, RuntimeTool>` and the matching model schema. Branch on
`descriptor`/`capabilities`, never on `kind` (the `backend-kind-literal-guard`
test enforces this).

### 4.2 Where to implement built-ins — two options

**Option A — author them as Eos `ToolDefinition`s** (`manager/tools/builtins/…`)
and project via a new un-prefixed projection.
- Pro: reuses `ToolDefinition` + the prompt-library description machinery.
- Con: `toRuntimeTool` + `prefixedToolName` give `mcp__worker__Write`, which
  `classifyTool` would classify as `mcp` (always-allow) — WRONG; built-ins need
  **bare** names to hit the file-edit/shell/read tables. So Option A needs a
  separate bare-name projection. Con: `ToolContext.api()` is a daemon HTTP
  loopback — wrong tool for direct `spec.cwd` filesystem access.

**Option B (recommended) — standalone `RuntimeTool`s in `infra/`** (e.g.
`infra/src/tools/builtins/`), bare-named, operating on the filesystem /
`child_process` scoped to `spec.cwd`, merged into the `tools` Map alongside the
prefixed control tools.
- Pro: filesystem/bash live in `infra` (Node) where the dependency direction
  allows it; `core` stays pure. Pro: bare names → existing policy stack applies
  free. Pro: each tool is a tiny `RuntimeTool` (ISP).
- This means `buildLaneTooling` merges two sources: control tools (prefixed,
  daemon-loopback `ctx`) + built-ins (bare, `cwd`-scoped). Both land in `items`
  (schema) and `tools` (dispatch).

Recommended structure: a `BuiltinToolRegistry` mirroring the existing
Open/Closed registries (`AgentBackendRegistry`, `StepExecutorRegistry`) — adding a
tool = one entry, no dispatch changes. Tools depend on a `FileSystem` /
`ProcessRunner` port (DIP) so they're unit-testable without touching the disk.

### 4.3 Files/ports a design would touch

- `core/src/use-cases/ToolRuntime.ts` — unchanged (reuse).
- New: `core/src/ports/` — a `FileSystem` / `ProcessRunner` port (DIP) if built-ins
  go through ports; new `BuiltinToolRegistry` port.
- New: `infra/src/tools/builtins/*.ts` — `RuntimeTool` impls (Read/Write/Edit/…).
- `manager/container.ts:743` `buildLaneTooling` — merge built-ins into `items` +
  `tools`.
- `manager/tools/projections.ts` — possibly a bare-name projection if Option A.
- `infra/src/backends/InProcessBackend.ts:55-57` — flip `enabled` once ready
  (gated by dim 1/dim 4 selection).
- Reuse unchanged: `PolicyToolGate`, `classifyTool`, `MODE_SPECS`, `policy.yaml`.

### 4.4 Streaming, parallel calls, errors

- **Streaming**: handled. `runTurn` prefers `streamTurn`; OpenAI streams fully,
  Anthropic falls back to `createTurn`. Tool-call argument deltas are
  intentionally dropped (only reasoning/text stream live) — matches the SDK lane.
- **Parallel tool calls**: a `ModelTurn` can carry many `toolCalls`; `runTurn`
  executes them **serially** (`ToolRuntime.ts:95-100`). Safe (ordered, gate `ask`
  is a blocking await) but slower than the SDK's parallel execution. Option:
  `Promise.all` the gated executes for read-only/independent tools; recommend
  **keep serial for v1**, note parallelization as a later optimization — and
  `log()` nothing is silently dropped (all calls still run).
- **Errors**: handled fail-closed. Denied / unknown / thrown → error
  `tool_result` fed back to the model (`executeGated`), never a skipped gate;
  model/transport errors → `turn:error` and the turn ends.

### 4.5 Cross-dimension seams

- **MCP tools (dim 3)** enter the SAME path: an MCP tool is just another entry in
  `items`/`tools` with an `mcp__<server>__<name>` name; `runTurn` dispatches it
  identically and `classifyTool` always-allows the `mcp` category. So dim-3 MCP +
  skill wiring plugs into `buildLaneTooling`'s tool list — no loop change.
- **Permission brokering (dim 5)**: every tool call already hits
  `makePolicyToolGate.decide` → `policyGateway.decide` → `classifyTool` +
  `editRegex` + `policy.yaml`. Built-ins inherit this for free **iff** bare
  canonical names + canonical input fields are used (§2.6).
- **`StepExecutor` is a DIFFERENT layer** (asked in the directive): the workflow
  engine's per-node Strategy (`core/src/ports/StepExecutor.ts`,
  `StepExecutorRegistry.ts`) executes workflow nodes (step/forEach/pipeline/…)
  and spawns workers via `WorkerSpawnPort`. It sits ABOVE the agent loop — a
  `step` node ultimately spawns a worker that, on an API profile, runs
  `InProcessBackend → runTurn`. It is NOT part of per-tool dispatch. It relates
  only as a structural ANALOGY (same Registry/Strategy/Open-Closed pattern to
  copy for `BuiltinToolRegistry`).

---

## 5. Open questions / conflicts with sibling dimensions

1. **Built-in fs/process access path** — direct Node `fs`/`child_process` in
   `infra`, or through a new `core` port (DIP)? Affects layering; recommend a
   port for testability. (Self-contained to this dim, but touches core/infra.)
2. **`Task` on the API lane** — nested `runTurn` sub-agent vs route to Eos
   spawning? → **dim 1** (lifecycle/selection).
3. **Built-in tool DESCRIPTIONS** — the prompt library (`prompts/tool/<name>`)
   holds Eos tool descriptions; built-ins need their own (the SDK ships these).
   → overlaps **dim 3 (prompts/skills)** / **dim 4**.
4. **Behavior parity / cross-lane drift** — do we need a tool-behavior
   conformance suite so API-lane `Read`/`Edit`/`Bash` match SDK/CLI semantics?
   (Recommended; new test surface.)
5. **`enabled:false` → on** — flipping the three descriptors and resumability
   (`sessionStore:"none"`, boot reconciliation) is **dim 1**, not this dim.
6. **Anthropic streaming** — `AnthropicModelClient` lacks `streamTurn`; acceptable
   for v1, or add SSE? → **dim 4 (model/config)**.
</content>
</invoke>
