# Dimension 03 — MCP servers · Skills · Slash-commands (the "feature" harness)

> Scope: how three worker "features" — external MCP servers, Agent Skills, and
> slash-commands — attach to a worker today across the claude-cli / claude-sdk
> lanes, and exactly what re-plumbing makes each work on the empty multi-provider
> API lane (`InProcessBackend` → `ToolRuntime.runTurn`).
>
> Builds on siblings (read first, not re-derived here):
> - **02-tool-harness.md** — the agentic loop (`ToolRuntime.runTurn`) exists and is
>   reusable; `buildLaneTooling` (`container.ts:743-754`) already merges Eos control
>   tools (`mcp__worker__*`/`mcp__orchestrator__*`) into the API lane's `items`
>   (model schema) + `tools` (dispatch map); an MCP tool is "just another entry" in
>   that map (02 §4.5). I confirm and extend this — the *control* tools are wired;
>   *external* MCP, skills, and command-expansion are not.
> - **01-backend-abstraction.md** — `InProcessBackend` is wired but `enabled:false`,
>   `sessionStore:"none"`; `clearContext` emits no `session:"cleared"` event (01 §3.1).
>   I confirm the `/clear` consequence from this dimension's angle (§2.3, §5).

---

## 1. Summary

The headline, one line per feature:

- **Eos control commands (`/clear`) ALREADY WORK on the API lane** — slash
  interception is backend-agnostic and capability-gated, and `InProcessBackend`
  has `contextClear:true`.
- **External MCP servers DO NOT reach the API lane** — the resolution *policy* is
  lane-neutral and reused by both claude lanes, but the API lane never calls it and
  has no MCP *client* to turn external servers into tools.
- **Skills DO NOT work on the API lane, and there is no Eos skills loader to reuse**
  — skills are 100% provider-supplied (binary/SDK native discovery); Eos only
  *relays* the body from the CLI transcript and *lists* skills for autocomplete.
- **User-authored `.claude/commands/*.md` prompt commands DO NOT expand on the API
  lane** — Eos discovers/lists them but the *binary* expands them; no Eos expander.

Five load-bearing facts (each grounded in §2/§3):

1. **MCP resolution is already a lane-neutral seam.** `resolveMcpServers`
   (`core/src/domain/mcp-resolution.ts:66-81`) + the `McpServerCatalog.listInherited`
   port (`core/src/ports/McpServerCatalog.ts:10-12`, impl
   `infra/src/mcp/FileMcpServerCatalog.ts:36-78`) compute the final server map for
   ANY lane. The per-lane part is only the **emit/consume adapter**: CLI writes JSON
   to disk (`writeMcpConfig`, `container.ts:507-527`) for the binary's MCP client;
   SDK translates to the SDK union (`toSdkMcpServers`, `SdkMcpTranslator.ts:18-57`)
   for the SDK's MCP client. **Both lanes delegate the actual MCP protocol I/O to
   the bundled `claude` binary. The API lane has no binary and no MCP client.**

2. **The API lane never invokes MCP resolution at all.** `buildLaneTooling`
   (`container.ts:743-754`) projects only `orchestratorDefs/workerDefs/peerDefs/
   workflowWorkerDefs` and the in-process factories (`container.ts:758-777`) pass no
   MCP-resolver dep to `createInProcessBackend` (contrast `resolveSdkMcpServers`
   wired onto the SDK backend, `container.ts:799`). So external servers are
   *completely absent* — not stubbed, just unwired.

3. **Eos owns zero skills code.** `SkillBlockSchema` (`contracts/src/canonical.ts:
   63-67`) is a transcript-relay *envelope* ("Absent for backends with no skill
   channel"), filled only by the CLI jsonl parser (`spawner/jsonl-parser.ts:
   139-148`). The SDK lane gets skills purely from `settingSources:["user","project"]`
   (`ClaudeSdkBackend.ts:287-292`); the CLI lane from the bundled binary. The
   `Skill` tool name appears nowhere in `tool-scope.ts`/registry/policy.

4. **Slash-commands split into two unrelated systems.** (a) Eos *control* commands —
   the `SlashCommand` registry (`core/src/domain/slash-command.ts`), assembled as
   `createSlashCommandRegistry([clearCommand])` (`container.ts:884`, **one command
   today**), intercepted in `DispatchMessage` (`DispatchMessage.ts:243-278`)
   backend-agnostically. (b) User/project/plugin *prompt-template* commands
   (`.claude/commands/*.md`) — listed by the `/commands` route (`commands.ts:
   108-140`) for autocomplete but **expanded by the binary**, never by Eos.

5. **The single merge point is already proven.** Everything new (external-MCP
   RuntimeTools, a `Skill` RuntimeTool, an expanded-command user message) plugs into
   the same `buildLaneTooling` `items`/`tools` (dim 2) and rides the same
   `runTurn` → `executeGated` → `makePolicyToolGate` path. No loop change, no new
   permission path (dim 5): MCP tool names stay `mcp__<server>__<name>` so
   `classifyTool` always-allows the `mcp` category (confirmed 02 §4.5 / 05).

**Net: of {MCP, skills, slash-commands}, only Eos control slash-commands work on
the API lane today. External MCP needs a new client+projection adapter; skills need
a net-new loader; prompt-template commands need a net-new expander.**

---

## 2. Current state (what exists today, cited)

### 2.1 MCP — resolution policy (lane-neutral) vs per-lane emit adapters

**Policy (pure, `core`).** `resolveMcpServers(input): ResolvedMcp`
(`core/src/domain/mcp-resolution.ts:66-81`) composes the final server map from
three sources and returns a `strict` flag:

```ts
// mcp-resolution.ts:18-23
export interface AgentMcpConfig {
  readonly inheritDefaults: boolean;
  readonly include: readonly string[]; // ["*"] = every inherited server
  readonly exclude: readonly string[];
  readonly extra: Readonly<Record<string, unknown>>;
}
// mcp-resolution.ts:66 — two modes:
//  nativeDiscovery=true  + no filter → { extra, builtins }, strict:false (binary self-discovers inherited)
//  nativeDiscovery=false OR filter   → { filtered-inherited, extra, builtins }, strict:true
```

`builtins` always win on name collision (gateway/worker/orchestrator infra servers).

**Discovery port.** `McpServerCatalog.listInherited(cwd)`
(`core/src/ports/McpServerCatalog.ts:10-12`); impl `FileMcpServerCatalog`
(`infra/src/mcp/FileMcpServerCatalog.ts:36-78`) reads `~/.claude.json` (user +
`projects[cwd]` scope) and `<cwd>/.mcp.json` (local), honoring
`enabledMcpjsonServers`/`disabledMcpjsonServers` gates; precedence
`{...user, ...project, ...local}`.

**Per-agent config source.** `config.mcp.orchestrator` / `config.mcp.worker`
(`manager/shared/config.ts:77-80`); default `DEFAULT_AGENT_MCP =
{inheritDefaults:true, include:["*"], exclude:[], extra:{}}` (`config.ts:153-158`).
Builtins map from `buildMcpBuiltins` (`container.ts:469-505`) keyed by
`EOS_BUILTIN_MCP_SERVERS = ["orchestrator","worker","gateway"]`
(`contracts/src/tool-scope.ts:9`).

**CLI lane emit** — `writeMcpConfig` (`container.ts:507-527`): calls
`resolveMcpServers({inherited, builtins, config})` (`:519`, `nativeDiscovery`
defaulted true) and `writeFileSync(path, JSON.stringify({mcpServers: servers}))`
(`:525`) to `~/.eos/mcp-<id>.json`; threaded as `spec.mcpConfig` + `mcpStrict`
(buildArgs `container.ts:413-427`) → the binary's `--mcp-config` /
`--strict-mcp-config`. **The binary runs the MCP client.**

**SDK lane consume** — `resolveSdkMcpServers` (`container.ts:787-792`): same policy
with `nativeDiscovery:false` (SDK can't self-discover), then `toSdkMcpServers`
(`SdkMcpTranslator.ts:18-57`) coerces each entry to the SDK
`McpServerConfig` union (stdio/sse/http; in-process `type:"sdk"` passed through;
unknown DROPPED + logged, `:35-57`). Merged into `query()` at `ClaudeSdkBackend.ts:
250-256`, with Eos control tools added as an **in-process SDK MCP server**
(`buildSdkToolServers` → `createSdkMcpServer`, `SdkToolHost.ts:49-65`). **The SDK
subprocess runs the MCP client.**

**PTY control-tool servers** — `worker-mcp.ts` / `orchestrator-mcp.ts` are the
claude-cli stdio MCP entrypoints: project each `ToolDefinition` via `toMcpModule`
and `server.connect(new StdioServerTransport())` (`worker-mcp.ts:22-31`).

### 2.2 Skills — provider-supplied; Eos relays + lists only

- **No Eos skills loader exists.** Confirmed by sweep: `Skill` is absent from
  `contracts/src/tool-scope.ts` and `manager/tools/registry.ts`; no loader/invoker
  anywhere.
- **Canonical relay envelope.** `SkillBlockSchema` (`canonical.ts:63-67`, in the
  `ContentBlockSchema` union `:69-75`): `{type:"skill", callId, text}` — "A Skill's
  injected SKILL.md body — claude-cli surfaces it as its own transcript entry keyed
  to the Skill tool_use id … **Absent for backends with no skill channel.**"
- **CLI relay.** `spawner/jsonl-parser.ts:139-148` emits `{kind:"skill_body",
  toolUseId, text}` when the transcript carries an `isMeta` user message tagged with
  `sourceToolUseID` (the injected SKILL.md body). One-way, CLI-transcript-specific.
- **SDK source.** `ClaudeSdkBackend.ts:287-292` — `settingSources:["user","project"]`
  so the bundled binary "discovers skills (and agents/commands/CLAUDE.md) natively,
  exactly like the CLI lane"; `managedSettings:{allowManagedPermissionRulesOnly:true}`
  (`:298`) still routes each skill-triggered tool call through `canUseTool`.
- **Discovery half exists (list-only).** The `/commands` route scans
  `.claude/skills/*/SKILL.md` via `scanSkills` (`commands.ts:67-87`) and plugin
  skills via `scanInstalledPluginSkills` (`:89-106`), returning name+description
  `CommandItem`s for composer autocomplete. **This reads frontmatter for display; it
  never loads bodies, injects metadata, or invokes anything.**

### 2.3 Slash-commands — two systems

**(a) Eos control commands.** Abstraction `core/src/domain/slash-command.ts`:
`SlashCommand` (`:42-51`) with `accepts(args, caps)` + `execute(ctx)`;
`parseSlash` (`:75-87`) does exact first-token match against an **allowlist** —
plain text, partials, claude-native `/compact`, and unknown `/foo` all return null
and **flow through as a normal message**. Registry assembled as
`createSlashCommandRegistry([clearCommand])` (`container.ts:884`) — **the only
command today is `/clear`**.

`clearCommand` (`core/src/domain/commands/clear.ts:11-29`):
```ts
accepts(args, caps) { return args === "" && caps.contextClear === true; } // :16-18
async execute(ctx) {
  const reset = (await ctx.session.clearContext?.()) ?? { ok:false };     // :21
  ctx.services.clearPendingQueue(ctx.workerId);                            // :24
  ctx.services.cancelPeerRequests(ctx.workerId);                           // :25
  ctx.services.appendConversationCleared(ctx.workerId, {via:"slash-command"}); // :26
  return { status:200, body:{ ok:reset.ok, cleared:true } };
}
```

Chokepoint `DispatchMessage.ts:243-278`: after the idempotency claim, before the
record build — `parseSlash` → `backend.attach(w.id, handle)` (handle is
`{kind:"inproc",ref}` for in-process, `:255-257`) → `accepts(args,
session.capabilities)` → `execute(...)`. If `accepts` is false or `parseSlash` null,
it falls through to a normal turn. **This path is identical for every backend** —
the only lane-specific bit is the handle shape and the backend's own `clearContext`.

`SlashSideEffects` impl (`manager/routes/dispatch-deps.ts:26-30`):
`clearPendingQueue → messageQueue.clearPending`, `cancelPeerRequests →
pendingPeerRequests.cancelByWorker`, `appendConversationCleared → appendSynthesized
(conversation_cleared)`. All daemon-side, backend-independent.

**Consequence for the API lane:** `InProcessBackend` declares `contextClear:true`
(01 §2.4 / 02 §2.3, `InProcessBackend.ts:44-51`), so `/clear` is *accepted* and
runs end-to-end. Caveat (confirmed from 01 §3.1): `InProcessBackend.clearContext`
drops the buffer but emits **no** `session:"cleared"` event, so the FSM's
context-token/task reset (`processAgentSignal`) doesn't fire — but the user-visible
`conversation_cleared` marker still appends via `SlashSideEffects`. So `/clear`
*works*; the cosmetic FSM reset is the open item (01 Option E).

**(b) User/project/plugin prompt-template commands.** The `/commands` route
(`manager/routes/commands.ts:108-140`) scans `.claude/commands/*.md` (`scanCommands`
`:25-65`, parsing frontmatter `name`/`description`/`argument-hint`) at project +
user scope, plus skills, returning `CommandItem[]` for the composer. **It is pure
discovery — no expansion, no execution.** When a user types `/mycommand`, `parseSlash`
returns null (not an Eos command) and the raw text flows to the backend; on
CLI/SDK the **binary** expands the `.md` template (arg substitution, `@file`,
`` !`bash` ``). There is no Eos-side template expander.

---

## 3. Gaps & missing pieces for the API lane

### 3.1 External MCP servers — MISSING client + projection (not stubbed, unwired)

What exists: the resolution policy (`resolveMcpServers`) + discovery
(`FileMcpServerCatalog`) are reusable as-is. What's missing for the API lane:

1. **No MCP client.** Both claude lanes delegate MCP protocol I/O
   (connect, `tools/list`, `tools/call`, lifecycle) to the bundled binary/SDK. The
   API lane (`InProcessBackend`/`runTurn`) has neither. Eos must embed an MCP client
   (e.g. `@modelcontextprotocol/sdk` `Client` over stdio/SSE/streamable-http —
   already a dependency, used server-side in `worker-mcp.ts`).
2. **No external→RuntimeTool projection.** Each remote tool must become a
   `RuntimeTool` (`{name:"mcp__<server>__<tool>", execute(input)→tools/call}`) merged
   into `buildLaneTooling`'s `items` (schema, from the server's `inputSchema`) +
   `tools` (dispatch). Today `buildLaneTooling` (`container.ts:743-754`) merges
   neither — it never calls `resolveMcpServers`/`listInherited`.
3. **No lifecycle owner.** Connections must open at `start`, survive across turns,
   and close at `stop`; a dead external server must not sink the worker (the SDK
   path drops+logs bad entries, `SdkMcpTranslator.ts:35-57` / `ClaudeSdkBackend.ts:
   253-255` — the API lane needs the same fail-soft posture).

### 3.2 Skills — MISSING entirely (no Eos infrastructure to reuse beyond discovery)

The API lane has no provider skill channel, and Eos owns no loader/invoker. To make
skills work, Eos must author the whole pipeline:

1. **Discovery** — reuse `scanSkills`/`scanInstalledPluginSkills` (`commands.ts:
   67-106`); generalize out of the route into a port so the API lane can call it.
2. **Progressive disclosure** — inject each skill's `name`+`description` (the
   trigger metadata) into the system prompt, and expose a `Skill` `RuntimeTool` that,
   given a skill name, returns the full `SKILL.md` body (the binary's mechanism).
3. **Surface** — emit the returned body as a `SkillBlock` (`callId`) so the existing
   canonical schema + UI render it unchanged (`canonical.ts:63-67`).
4. **Resources** — skill-bundled scripts/assets need `cwd`/path resolution so `Bash`
   (dim 2) can run them.

### 3.3 Prompt-template commands — MISSING expander

`.claude/commands/*.md` are discovered (`scanCommands`) but expanded only by the
binary. The API lane needs an Eos-side expander: read the `.md`, substitute
`$ARGUMENTS`/`$1…`, resolve `@file` includes and `` !`cmd` `` (via the dim-2 `Bash`
tool), then inject the expanded text as the user message before `runTurn`. The
discovery half exists; the expander is net-new.

### 3.4 Claude-native commands (`/compact`, etc.) — no binary on the API lane

These are TUI/SDK-owned. On the API lane there is no process to interpret them. They
either become Eos control commands (e.g. a `/compact` that summarizes+clears via the
model + `clearContext`) or stay unsupported (they fall through as raw text today).

---

## 4. Design implications & options

### 4.1 MCP — add a third emit/consume adapter (Open/Closed)

The clean factoring is already visible: resolution is lane-neutral, the lane differs
only in the emit adapter (CLI=JSON file, SDK=union+`createSdkMcpServer`). The API
lane is a **third adapter** of the same shape — call it `resolveRuntimeMcpTools`,
symmetric to `resolveSdkMcpServers`:

```
spec → cfg = config.mcp.{orchestrator|worker}
     → inherited = mcpCatalog.listInherited(spec.cwd)
     → { servers } = resolveMcpServers({inherited, builtins:{}, config:cfg, nativeDiscovery:false})
     → for each server: connect MCP client, tools/list, wrap each as RuntimeTool
     → merge into buildLaneTooling items + tools
```

- **`builtins` is empty here** (Eos control tools are added separately as
  RuntimeTools by `buildLaneTooling` — they are NOT MCP servers on this lane, unlike
  the SDK lane where they ride an in-process SDK MCP server).
- **Ports/files touched:** new `infra/src/mcp/RuntimeMcpClient.ts` (the embedded MCP
  `Client` + connection registry, lifecycle-scoped to the `InProcessBackend`
  session); new `manager/` wiring that injects an MCP-resolver dep into
  `createInProcessBackend` (today omitted, `container.ts:758-777`); extend
  `InProcessEnv`/factory (02 §2.3) so the env carries the live MCP tool map; merge in
  `buildLaneTooling` (`container.ts:743-754`). `resolveMcpServers` + `FileMcpServer
  Catalog` + `AgentMcpConfig` unchanged.
- **DIP/ISP:** the connection client is a port (`McpToolClient`) so tests inject a
  fake; each remote tool is a tiny `RuntimeTool`.
- **Permissions (dim 5):** keep `mcp__<server>__<name>` naming → `classifyTool`
  always-allows the `mcp` category; no new policy path. (Confirmed 02 §4.5.)

Reuse note: `toSdkMcpServers`'s coercion logic (`SdkMcpTranslator.ts:35-57`) is the
template for which shapes to support (stdio/sse/http) and which to drop.

### 4.2 Skills — net-new `SkillRegistry` + `Skill` RuntimeTool

Mirror the existing Open/Closed registries (`SlashCommandRegistry`,
`AgentBackendRegistry`). Pieces:

- **`core/src/ports/SkillCatalog.ts`** (new): `listSkills(cwd): SkillMeta[]` +
  `loadBody(name): string`. Infra adapter generalizes `scanSkills` out of
  `commands.ts:67-106`.
- **`Skill` `RuntimeTool`** (infra): input `{name}` → `loadBody` → returns the body;
  the loop feeds it back like any tool result, and the emit path tags it as a
  `SkillBlock` (`callId` = the tool call id) so the UI renders it via the existing
  schema.
- **System-prompt injection** (dim 4 seam): the skill *trigger* metadata
  (name+description) belongs in the assembled prompt — overlaps DPI/prompt assembly
  (`assembleAppendFor`), so coordinate with dim 4 on where skill metadata is folded
  in (the SDK lane gets this free from the binary; the API lane must inject it).
- **Scope:** v1 can ship discovery + manual `Skill` invocation; auto-trigger fidelity
  (the binary's heuristics) is a later refinement. `log()` what's discovered so a
  skipped/oversized skill is never silently dropped.

This is the largest net-new surface in the dimension — flag it as such.

### 4.3 Slash-commands — keep control commands, add an expander

- **Eos control commands: nothing to build.** `/clear` already works on the API lane
  (§2.3). Adding more (e.g. `/compact`) is one registry entry — the open/closed
  design holds across lanes. Pair with **01 Option E** (emit `session:"cleared"` from
  `InProcessBackend.clearContext`) so the FSM reset fires; small + isolated.
- **Prompt-template expander** (new): a `core` domain `expandCommandTemplate(md,
  args, ctx)` + an infra reader, invoked in `DispatchMessage` *only when the backend
  lacks native expansion* (capability-gated, e.g. a new `expandsSlashTemplates`
  capability that claude-cli/claude-sdk set true and `InProcessBackend` sets false —
  branch on capability, never kind). Discovery reuses `scanCommands`. The expanded
  text replaces `input.text` before the normal dispatch.

### 4.4 The single merge point makes all three composable

All three land in `buildLaneTooling`'s `items`/`tools` (MCP RuntimeTools, the `Skill`
tool) or as a pre-`runTurn` user-message rewrite (command expansion). No change to
`ToolRuntime.runTurn`, `executeGated`, or the gate — exactly the dim-2 conclusion,
extended: the loop and control tools exist; these features are additional tool-map
entries + one prompt-injection + one message-rewrite.

---

## 5. Open questions / conflicts with sibling dimensions

1. **Skill metadata injection owner (dim 4).** The skill trigger
   (name+description) must enter the system prompt. The SDK lane gets it from the
   binary; the API lane needs it assembled into the DPI append (`assembleAppendFor`,
   `container.ts:804`). Who owns folding skill metadata into prompt assembly — dim 3
   (this) or dim 4 (DPI/config)? Recommend dim 4 owns the prompt slot, dim 3 supplies
   the catalog.
2. **`/clear` FSM reset (01 §3.1 / 01 Option E).** Confirmed from this angle:
   `InProcessBackend.clearContext` emits no `session:"cleared"`, so context-token/task
   reset doesn't fire though the `conversation_cleared` marker does. Whether to fix
   here or in dim 1 — the command side is correct; the backend event is the gap.
   Flagged, recommend the one-line fix in dim 1.
3. **MCP client lifecycle vs `sessionStore:"none"` (dim 1).** External MCP
   connections live in the in-memory session; a daemon restart loses them (same
   non-durability as the conversation, 01 §3.2). If/when the lane becomes resumable,
   reconnection must be part of `attach`/resume. Dim 1's call.
4. **Permission category for external MCP tools (dim 5).** Confirmed they ride the
   `mcp` always-allow category via `classifyTool` (02 §4.5). Open: should external
   (non-Eos) MCP tools be policy-gated more tightly than Eos control tools, given
   they're third-party? Currently both are `mcp`. Dim 5's call.
5. **`Skill`/expanded-command billing.** A `Skill` body or expanded `.md` inflates
   the prompt; on a metered API lane this is real cost (dim 4 billing). The body is
   injected once per invocation — note for the cost model.
6. **No HTTP route lists Eos control commands.** `/commands` (`commands.ts:108-140`)
   serves only `.claude/commands`+skills, not the `SlashCommand` registry. If the web
   composer should advertise `/clear` (and future control commands), a small
   `registry.list()` endpoint is needed — minor, cross-cuts the web UI.
