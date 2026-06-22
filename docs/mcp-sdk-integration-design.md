# Design: inherited / external MCP servers on the claude-sdk lane

Status: design report — no production code changed.
Scope: let an SDK-lane worker see the external/inherited MCP servers
(`.mcp.json`, `~/.claude.json`) that the cli/PTY lane already exposes, reusing the
existing core resolution policy and adding only an SDK-side output adapter.

Evidence below was obtained from the source plus three peer experts
(cli-mcp-wiring-expert, sdk-backend-expert, sdk-mcp-api-expert). File:line claims
marked CONFIRMED were verified against the code; claims I could not pin to a single
authoritative line are marked OPEN.

---

## 1. Problem statement + confirmed gap

The premise "the SDK can't do MCP" is FALSE. `@anthropic-ai/claude-agent-sdk`
v0.3.179 accepts `Options.mcpServers?: Record<string, McpServerConfig>`
(`sdk.d.ts:1679`), and Eos already ships its in-process Eos tools on this lane via
`createSdkMcpServer` (`SdkToolHost.ts:58`). The transports the union supports are
stdio | sse | http | in-process sdk (`sdk.d.ts:1053`).

The ONLY gap: external/inherited servers are dropped on the SDK lane. Three
confirmed facts produce the gap:

1. The SDK lane builds `mcpServers` ONLY from `buildSdkToolServers`, which returns
   exactly one in-process server (`{ [orchestrator|worker]: createSdkMcpServer(...) }`)
   — `SdkToolHost.ts:47-61` (`:58`), consumed at `ClaudeSdkBackend.ts:176-180` and
   passed at `:199`. CONFIRMED (sdk-backend-expert).

2. `mcpCatalog.listInherited` / `FileMcpServerCatalog` / `resolveMcpServers` are
   NEVER called on this lane. The SDK backend deps carry only
   `{ orchestratorDefs, workerDefs, peerDefs, renderDescriptions }`
   (`container.ts:740`) — no `mcpCatalog`, no `config.mcp`. `FileMcpServerCatalog`
   is instantiated at `container.ts:453` and used ONLY by the cli-lane
   `writeMcpConfig` (`container.ts:503`). CONFIRMED.

3. `settingSources: []` (`ClaudeSdkBackend.ts:213`) + `strictMcpConfig: true`
   (`:214`) together suppress ALL of the SDK's own MCP discovery (`.mcp.json`,
   `~/.claude.json`, plugins, claude.ai connectors). So the worker sees ONLY what is
   in the passed `mcpServers` record — today, the single Eos server. CONFIRMED.

How the cli lane gets this right today (the reference path, lane-agnostic up to the
final emit):

- `mcpCatalog.listInherited(cwd)` returns the inherited server map as raw JSON
  values straight from disk, no normalization — `FileMcpServerCatalog.listInherited`
  (`:43-53`), values assigned unparsed (`:71-74`). CONFIRMED.
- `resolveMcpServers({ inherited, builtins, config })` filters + merges with
  **builtins winning on name collision** — `core/src/domain/mcp-resolution.ts:60-69`
  (precedence via spread order at `:68`). CONFIRMED.
- The cli lane SERIALIZES that map to `~/.eos/mcp-<id>.json` as
  `{ mcpServers: servers }` (`container.ts:510`) and passes `--mcp-config <path>`
  (`worker-args.ts:63`, re-emitted at `spawner/claude-args.ts:46`). It adds
  `--strict-mcp-config` UNLESS strict is false (`claude-args.ts:45`:
  `if (opts.mcpStrict !== false) args.push("--strict-mcp-config")`). CONFIRMED.

Default config ships ADDITIVE: `DEFAULT_AGENT_MCP = { inheritDefaults: true,
include: ["*"], exclude: [], extra: {} }` (`config.ts:136-141`), applied to both
roles (`config.ts:233-234`). In additive mode `resolveMcpServers` emits only
`extra + builtins` and lets the claude binary discover inherited servers itself
(`mcp-resolution.ts:62-63`, `strict: false`).

**Load-bearing consequence (cli-mcp-wiring-expert):** the cli lane's correctness
for external/connector servers in the default config comes ENTIRELY from the
binary's native discovery in additive mode — Eos never enumerates them there. The
SDK lane has no native discovery (fact 3). So the SDK lane cannot simply call
`resolveMcpServers` with the default config: its additive branch deliberately omits
inherited servers (relying on a discovery the SDK doesn't have), which would
reproduce today's empty-inherited behavior. The SDK lane must **explicitly
enumerate** the inherited set via `listInherited` and pass it in.

---

## 2. SOLID design

### Seam (one sentence)

Reuse the existing pure core policy `resolveMcpServers` for both lanes (extended
with one `nativeDiscovery` flag so a lane that can't self-discover always
materializes the inherited set), and add a single SDK-side output adapter that
translates the resolved map into the `McpServerConfig` union — symmetric to the cli
lane's JSON serialization.

### Why this seam

The inherited resolution is ALREADY lane-agnostic and pure: `listInherited` (infra
port impl) + `resolveMcpServers` (core domain). The genuine asymmetry is only the
final emit step — cli serializes to JSON for `--mcp-config`; SDK instantiates a
`Record<string, McpServerConfig>` for `query()`. Each lane owns ONLY that emit
adapter. Nothing about the cli path changes (OCP).

### Components and layers (dependency direction `contracts → core → infra → entrypoints`)

| Piece | Layer | Add/Change | Imports |
|---|---|---|---|
| `resolveMcpServers` (+ `nativeDiscovery` flag) | **core** `core/src/domain/mcp-resolution.ts` | CHANGE | none new (stays pure) |
| `McpServerCatalog` port | core `core/src/ports/McpServerCatalog.ts` | unchanged | none |
| `FileMcpServerCatalog` | **infra** `infra/src/mcp/FileMcpServerCatalog.ts` | unchanged | node:fs |
| `toSdkMcpServers` translator | **entrypoint** `manager/backends/sdk/SdkMcpTranslator.ts` | ADD | `type McpServerConfig` from SDK |
| `ClaudeSdkBackend` (optional `resolveSdkMcpServers` dep) | **entrypoint** `manager/backends/sdk/ClaudeSdkBackend.ts` | CHANGE | core + SDK |
| container composition + inject (claudeSdkBackend only) | **entrypoint** `manager/container.ts` | CHANGE | core + infra + SDK adapter |

Direction holds: the only new core edit (`resolveMcpServers`) imports nothing new
and stays Node/SDK-free — it operates on `Record<string, unknown>`, so it can carry
in-process SDK instances as opaque values without importing the SDK type. The
SDK-shaped translation lives in `manager/` (entrypoint), which may import the SDK
package; core never does. infra is untouched. No `core → infra` or `core → manager`
edge is introduced. **DIP:** both lanes depend on the core abstraction
(`resolveMcpServers`); neither depends on the other's emit adapter.

### Why this is "capabilities, not kind"

The backend-kind-literal-guard (`manager/backends/__tests__/backend-kind-literal-guard.test.ts`)
fails on any `=== "claude-cli"` / `=== "claude-sdk"` comparison
(`COMPARE_RE`, `:23`; scans `core/src` and `manager`, `:16`). This design introduces
NO such comparison:

- The SDK-specific behavior is encoded by **composition**, not a runtime kind check:
  the container wires the `resolveSdkMcpServers` dep onto the `claudeSdkBackend`
  instance and omits it on `judgeBackend` — exactly the existing pattern for the
  optional `assembleAppendPrompt` dep (`container.ts:747` populated vs `:761`
  omitted). Backend code treats the dep as optional and never asks "what kind am I".
- The `nativeDiscovery: false` argument is the SDK lane stating its own capability
  at the composition site, not a string comparison. (Optional refinement below
  promotes it to a typed `AgentCapabilities` field for full rigor.)

### SOLID mapping (each choice → principle)

- **DRY + SRP** — the filter + builtins-win precedence lives in ONE place
  (`resolveMcpServers`). The translator does ONLY shape coercion. The container does
  ONLY composition. No duplicated precedence logic across lanes.
- **OCP** — `nativeDiscovery` defaults to `true`, so the cli call site
  (`container.ts:504`) and its tests are untouched; adding the SDK lane does not
  modify the cli lane. The translator is additive.
- **DIP** — `ClaudeSdkBackend` depends on an injected `resolveSdkMcpServers`
  abstraction, not on `FileMcpServerCatalog` or `config` concretes. The judge gets a
  no-op (dep omitted) by construction.
- **LSP** — every value the translator emits is a valid `McpServerConfig` union
  member; in-process instances and external configs are substitutable wherever
  `query()` expects the union.
- **ISP** — the injected dep is a single narrow function
  `(spec, builtins) => { mcpServers, dropped }`, not a fat catalog interface forced
  onto the backend.

### Sequence (SDK `start()` after the change)

1. `buildSdkToolServers(...)` → `{ mcpServers: builtins, allowedTools: [] }`
   (the in-process Eos server instance(s); `SdkToolHost.ts:57-60`).
2. If `deps.resolveSdkMcpServers` present, call it with `(spec, builtins)`:
   a. `cfg = spec.isOrchestrator ? config.mcp.orchestrator : config.mcp.worker`
   b. `inherited = spec.cwd ? mcpCatalog.listInherited(spec.cwd) : {}`
      — `spec.cwd` is already the materialized worktree dir at `start()` time on the
      in-process lane (the daemon materializes BEFORE start; `SpawnWorker.ts:120-124`,
      cwd computed at `:247`), so no `worktreeFrom` fallback is needed here. Guard
      `""` like the cli lane (`container.ts:503`). CONFIRMED (sdk-backend-expert).
   c. `resolved = resolveMcpServers({ inherited, builtins, config: cfg, nativeDiscovery: false })`
      → merged `Record<string, unknown>`, **builtins win** (core policy, unchanged).
   d. `{ mcpServers, dropped } = toSdkMcpServers(resolved.servers)` → translated
      union map; `dropped` logged via `deps.log.warn`.
   Else (judge / no catalog): `mcpServers = builtins`.
3. `baseOptions.mcpServers = mcpServers`. `strictMcpConfig: true` and
   `settingSources: []` stay UNCHANGED (we pass an explicit complete set, we do not
   re-enable native discovery).
4. `allowedTools` stays `[]`; `canUseTool` unchanged — every `mcp__<server>__<tool>`
   name (Eos or external) routes to `PolicyGatewayService`. `makeCanUseTool`
   (`SdkPermissionBridge.ts:22-34`) is name-agnostic: no allowlist, only the
   `AskUserQuestion`/`Task` hard-deny via `disallowedTools` (`ClaudeSdkBackend.ts:208`).
   CONFIRMED. **No permission change required.**

---

## 3. Minimal diff sketch per file

### CHANGE — `core/src/domain/mcp-resolution.ts` (~6 lines)

```ts
export interface ResolveMcpInput {
  inherited: Record<string, unknown>;
  builtins: Record<string, unknown>;
  config: AgentMcpConfig;
  // Lanes that cannot self-discover MCP scopes (claude-sdk: settingSources:[]).
  // false → ALWAYS materialize the filtered inherited set; the additive shortcut
  // would silently drop every inherited server. Default true = cli behavior.
  nativeDiscovery?: boolean;
}

export function resolveMcpServers(input: ResolveMcpInput): ResolvedMcp {
  const { inherited, builtins, config, nativeDiscovery = true } = input;
  if (!nativeDiscovery) {
    const base = config.inheritDefaults
      ? filterInherited(inherited, config.include, config.exclude) : {};
    return { servers: { ...base, ...config.extra, ...builtins }, strict: true };
  }
  // unchanged below — cli additive/strict path
  if (!isFilterActive(config)) return { servers: { ...config.extra, ...builtins }, strict: false };
  const base = config.inheritDefaults
    ? filterInherited(inherited, config.include, config.exclude) : {};
  return { servers: { ...base, ...config.extra, ...builtins }, strict: true };
}
```

### ADD — `manager/backends/sdk/SdkMcpTranslator.ts`

```ts
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export interface DroppedServer { name: string; reason: string; }

// Translate a resolved Eos server map (mixed: in-process SDK instances from
// createSdkMcpServer + raw external JSON entries from ~/.claude.json/.mcp.json)
// into the SDK McpServerConfig union. Instances pass through; serializable external
// entries are coerced; anything unrecognized is DROPPED (never thrown) so one
// malformed inherited entry cannot sink the worker.
export function toSdkMcpServers(
  servers: Record<string, unknown>,
): { mcpServers: Record<string, McpServerConfig>; dropped: DroppedServer[] } {
  const mcpServers: Record<string, McpServerConfig> = {};
  const dropped: DroppedServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const cfg = coerce(raw);
    if (cfg) mcpServers[name] = cfg;
    else dropped.push({ name, reason: "unsupported MCP server shape" });
  }
  return { mcpServers, dropped };
}

function coerce(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.type === "sdk" || "instance" in o) return raw as McpServerConfig; // Eos in-process
  if (o.type === "sse")  return { type: "sse",  url: String(o.url), ...(o.headers ? { headers: o.headers as Record<string,string> } : {}) } as McpServerConfig;
  if (o.type === "http" || o.type === "streamable-http") // SDK union only accepts "http"
    return { type: "http", url: String(o.url), ...(o.headers ? { headers: o.headers as Record<string,string> } : {}) } as McpServerConfig;
  if (typeof o.command === "string")
    return { type: "stdio", command: o.command, ...(o.args ? { args: o.args as string[] } : {}), ...(o.env ? { env: o.env as Record<string,string> } : {}) } as McpServerConfig;
  return null; // claudeai-proxy / unknown → drop (logged by caller)
}
```

Note: `alwaysLoad` is deliberately NOT propagated to external servers (left unset →
non-blocking lazy connect; see edge-case table). Only explicit known fields are
rebuilt, so stray JSON keys never leak into the SDK call.

### CHANGE — `manager/backends/sdk/ClaudeSdkBackend.ts` (~8 lines)

```ts
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { DroppedServer } from "./SdkMcpTranslator.ts";

export interface ClaudeSdkBackendDeps {
  // ...existing...
  /** Resolve + translate the worker's inherited/external MCP servers into the SDK
   *  union, MERGED with the in-process Eos builtins (builtins win). OMITTED on the
   *  judge backend → that session sees only its (empty) builtins. Mirrors the
   *  optional assembleAppendPrompt dep. */
  resolveSdkMcpServers?(spec: AgentLaunchSpec, builtins: Record<string, McpServerConfig>):
    { mcpServers: Record<string, McpServerConfig>; dropped: DroppedServer[] };
}

// in start(), replacing lines 176-180:
const built = buildSdkToolServers(deps.toolHost, {
  isOrchestrator: spec.isOrchestrator, collaborate: opts.collaborate === true, ctx,
});
const allowedTools = built.allowedTools;
let mcpServers = built.mcpServers;
if (deps.resolveSdkMcpServers) {
  const r = deps.resolveSdkMcpServers(spec, built.mcpServers);
  mcpServers = r.mcpServers;
  if (r.dropped.length) deps.log?.warn("dropped inherited MCP servers", { workerId: spec.workerId, dropped: r.dropped });
}
// baseOptions.mcpServers = mcpServers;  // strictMcpConfig:true + settingSources:[] UNCHANGED (:213-214)
```

### CHANGE — `manager/container.ts` (~12 lines, near 737-749)

```ts
import { toSdkMcpServers } from "./backends/sdk/SdkMcpTranslator.ts";
// resolveMcpServers already imported (:88); mcpCatalog already built (:453).

const resolveSdkMcpServers = (spec: AgentLaunchSpec, builtins: Record<string, McpServerConfig>) => {
  const cfg = spec.isOrchestrator ? config.mcp.orchestrator : config.mcp.worker;
  const inherited = spec.cwd ? mcpCatalog.listInherited(spec.cwd) : {};
  const { servers } = resolveMcpServers({ inherited, builtins, config: cfg, nativeDiscovery: false });
  return toSdkMcpServers(servers);
};

const claudeSdkBackend = createClaudeSdkBackend({
  authResolver, policy: sdkPolicy,
  toolHost: { orchestratorDefs, workerDefs, peerDefs, renderDescriptions: renderInprocToolDescriptions },
  daemonUrl: sdkDaemonUrl, makeToolContext,
  assembleAppendPrompt: (spec) => assembleAppendFor(/* ... */),
  resolveSdkMcpServers,            // <-- populated HERE only
  log,
});

const judgeBackend = createClaudeSdkBackend({
  authResolver, policy: sdkPolicy,
  toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], renderDescriptions: () => ({}) },
  daemonUrl: sdkDaemonUrl, makeToolContext,
  // resolveSdkMcpServers OMITTED → judge sees no inherited servers (stays clean)
  log,
});
```

---

## 4. Edge-case table

| # | Edge case | Resolution |
|---|---|---|
| 1 | In-process `sdk`-type servers are non-serializable & same-process only (`McpSdkServerConfigWithInstance`, "Not serializable" `sdk.d.ts:1042-1048`). The cli JSON path can't carry them; the SDK path can. | The neutral representation (`Record<string, unknown>` from `resolveMcpServers`) carries BOTH instances and raw external configs. The translator detects `type:"sdk"` / `"instance" in o` and passes the instance through; external entries get coerced. The cli lane simply never has instances (its builtins are stdio `node`/`bun` command objects, `container.ts:469-484`), so its JSON serialization is lossless for what it actually holds. This is the core asymmetry, handled by lane-specific emit adapters over a shared neutral map. CONFIRMED (sdk-mcp-api-expert). |
| 2 | cli JSON entry → SDK `McpServerConfig` translation. | stdio `{command,args,env}` (type optional), sse `{type:"sse",url,headers?}`, http `{type:"http",url,headers?}` are byte-compatible with the SDK union (`sdk.d.ts:1151/1135/1021`) — no rename. ONE coercion: a JSON entry with `type:"streamable-http"` (a `.mcp.json` alias) MUST be rewritten to `"http"`; the programmatic union accepts only `"http"`. Translator does this. CONFIRMED (sdk-mcp-api-expert). |
| 3 | Collision precedence — Eos builtins must win. | Handled by the unchanged core spread order `{ ...base, ...extra, ...builtins }` (`mcp-resolution.ts:68`). An inherited/extra server named `orchestrator`/`worker`/`gateway` is overwritten by the builtin. Reused on the SDK lane, not re-implemented. CONFIRMED. |
| 4 | Keep `strictMcpConfig: true`? | KEEP. We pass an explicit pre-merged set; `strictMcpConfig:true` + explicit `mcpServers` = the complete-and-only set and does NOT drop explicitly-passed servers (`sdk.d.ts:1924-1931`). Re-enabling native discovery would duplicate/conflict with our enumeration and reintroduce the ambient-tool leak the comment at `ClaudeSdkBackend.ts:211-212` guards against. CONFIRMED (sdk-mcp-api-expert). |
| 5 | `settingSources: []` interaction. | KEEP `[]`. It governs CLAUDE.md/settings-file load (memory is handled separately via `assembleAppendPrompt`); it also disables native MCP discovery — which is precisely why the SDK lane must enumerate inherited servers explicitly (`nativeDiscovery:false`). Do not change it. CONFIRMED. |
| 6 | Tool-name collisions. | Tools are namespaced by server prefix (`mcp__<server>__<tool>`), so two distinct servers never collide at the tool level. SERVER-name collisions resolve via edge #3 (builtin wins). No extra handling. |
| 7 | `alwaysLoad`. | Do NOT set `alwaysLoad` on external servers → default false → non-blocking lazy connect, so a slow/dead external server can't block turn-1 startup (the `alwaysLoad` path blocks up to a 5s connect cap, `sdk.d.ts:1031/1145/1161`). Eos's in-process server needs no connect (always present). The cli builtins set `alwaysLoad:true` (`container.ts:473`) because the binary must have them turn-1; that does not apply to in-process instances. CONFIRMED. |
| 8 | A single external server fails → must not break the worker. | Two layers: (a) the translator DROPS malformed/unsupported entries (returns `null`, logs, never throws); (b) at runtime SDK MCP startup is non-blocking by default — a server that fails to connect surfaces as `McpServerStatus.status:"failed"` (`sdk.d.ts:1060-1101`) in the init message while the session and other servers continue. So neither a malformed config nor an unreachable server sinks the worker. The "does not abort `query()`" half is **OPEN**: confirmed by the non-blocking-startup comment + per-server status type + docs error-handling example, but there is no single `sdk.d.ts` line that guarantees it — verify in the integration test / a live smoke. (sdk-mcp-api-expert.) |
| 9 | claude.ai connectors + plugin-scoped servers. | CANNOT be carried on the SDK lane. `FileMcpServerCatalog` does not enumerate them (`FileMcpServerCatalog.ts:9-10`), AND the `mcpServers` input union has no claude.ai variant — `McpClaudeAIProxyServerConfig` exists (`sdk.d.ts:1011-1019`) but appears only in `McpServerStatusConfig` (`:1103`), not in `McpServerConfig` (`:1053`). Inherent gap (also true of the cli lane in strict mode). A connector-backed `context7` is therefore SDK-unsupported; `context7` configured as a plain `.mcp.json` http/stdio server WOULD work. Bridging connectors is **OPEN / out of scope**. CONFIRMED (both peers). |

---

## 5. Test plan

Unit — core resolver (`core/src/__tests__/mcp-resolution.test.ts`, extend):
- `nativeDiscovery:false` + default config (`inheritDefaults:true, include:["*"]`)
  → `servers` INCLUDES inherited + builtins (NOT the additive-omits-inherited
  behavior), `strict:true`.
- builtins win on name collision under `nativeDiscovery:false`.
- regression guard: `nativeDiscovery` omitted → existing cli additive/strict
  outputs UNCHANGED (protects the cli lane / OCP).

Unit — translator (`manager/backends/sdk/__tests__/sdk-mcp-translator.test.ts`, new):
- stdio passthrough with `type` omitted → emits `type:"stdio"`.
- sse / http passthrough; `type:"streamable-http"` → rewritten to `"http"`.
- in-process instance (`type:"sdk"` / has `instance`) → passed through unchanged.
- claudeai-proxy / unknown shape / `null` / string → DROPPED with a reason, no throw.
- `alwaysLoad` NOT present on emitted external entries.

Integration — backend sees an external tool
(`manager/backends/sdk/__tests__/claude-sdk.test.ts`, extend; use the existing
`queryFn` capture seam — `capturedOptions`, `:276-317`):
- inject a fake `resolveSdkMcpServers` returning one external stdio server merged
  with the Eos builtin; assert `capturedOptions.mcpServers` contains BOTH the Eos
  server (`mcp__worker`-prefixed server name) AND the external server; assert
  `strictMcpConfig === true` and `settingSources` still `[]`; assert
  `typeof canUseTool === "function"`.
- judge path: backend WITHOUT `resolveSdkMcpServers` → `capturedOptions.mcpServers`
  has ONLY the builtin (no inherited leak — protects DIP/judge isolation).
- (optional) a fake that returns a `dropped` entry → assert `log.warn` called and
  the session still starts (covers edge #8's translator half).

Guard — `manager/backends/__tests__/backend-kind-literal-guard.test.ts` MUST still
pass: the new files (scanned via `SCAN_DIRS` incl. `core/src` and `manager`,
`:16`) contain NO `=== "claude-cli"`/`"claude-sdk"` comparison. The design is
composition + a capability boolean, so this holds by construction.

---

## 6. Optional refinement (not required)

Promote `nativeDiscovery` to a typed capability for full capabilities-not-kind
rigor: add `nativeMcpDiscovery: boolean` to `AgentCapabilities`
(`core/src/ports/AgentBackend.ts`) — `false` in `SDK_DESCRIPTOR.CAPS`, `true` on the
cli descriptor — and have the composition read
`capabilities.nativeMcpDiscovery` instead of a literal `false`. This makes future
backends declare the trait in data. It is strictly optional: the per-instance
composition already yields lane-correct behavior with no runtime kind branch.

---

## 7. OPEN items

- O1 — "A failed external server does not abort `query()`": strongly supported
  (non-blocking startup + independent per-server `McpServerStatus` + docs
  error-handling example) but not a single typed guarantee in `sdk.d.ts:0.3.179`.
  Verify in the integration test and/or a live smoke.
- O2 — claude.ai connectors + plugin MCP servers: provably unsupportable via
  `listInherited` + the `mcpServers` union (edge #9). Whether to add a
  connector bridge later is out of scope.
- O3 — Excess unknown JSON fields on inherited entries: runtime-tolerated by the
  SDK but not type-guaranteed; mostly moot here because the translator rebuilds
  objects with only known fields rather than passing raw entries through.
