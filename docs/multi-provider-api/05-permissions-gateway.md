# Dimension 05 — Permissions, Capability-Gating & the Gateway

> Scope: does the API lane's new built-in toolset (dim 2's ~16:
> Read/Write/Edit/MultiEdit/NotebookEdit/Bash/Glob/Grep/LS/WebFetch/WebSearch/…)
> get policed correctly by the SAME permission broker that gates the SDK/CLI
> lanes — mode + worker-def allow/deny + editRegex + policy.yaml + blocked-builtin
> hard-deny — under bare-name keying? This file validates that end-to-end and
> lists the exact gating gaps to close.
>
> Sibling status at write time: `02-tool-harness.md` present (built on below);
> `03-mcp-skills.md` / `04-config-model.md` not yet on disk (concurrent round-2) —
> seams to them flagged inline, not re-covered.

---

## 1. Summary

Load-bearing facts (each grounded in §2):

1. **One decision engine, three lanes — all keyed on the BARE tool name + raw
   input fields, with ZERO backend branching.** `PolicyGatewayService.evaluate`
   (`core/src/services/PolicyGatewayService.ts:125-193`) is pure `core`; it reads
   only `toolName` and `input.{command,file_path,notebook_path}`. The claude-sdk
   lane (`makeCanUseTool`) and the API/in-process lane (`makePolicyToolGate`) are
   handed the **same `sdkPolicy` adapter instance** (`container.ts:758-765`,
   `:793-799`) that wraps this engine in-process; the claude-cli lane reaches the
   same engine over HTTP `POST /policy/decide` (`manager/routes/policy.ts:15-25`).

2. **VERDICT: the new built-in tools are gated correctly FOR FREE — provided dim 2
   uses the exact canonical names + input fields.** editRegex on
   Write/Edit/MultiEdit/NotebookEdit (`PolicyGatewayService.ts:169-177`), Bash
   command allow/deny + the `rm -rf /` policy.yaml denies
   (`policy.ts:84-94`, `policy.example.yaml:11-16`), permission-mode category
   verdicts (`permission-mode.ts:56-95`), worker-def allow/deny
   (`PolicyGatewayService.ts:155-165`), blocked-builtin hard-deny
   (`PolicyToolGate.ts:14`), and the long-poll "ask" (`PolicyGatewayService.ts:99-118`)
   ALL apply to the API lane with no new wiring. No `=== "kind"` branch is added.

3. **ONE real safety gap: the `updatedInput` / policy-`rewrite` path is silently
   dropped on the API lane.** `makePolicyToolGate` returns only `{allow}` /
   `{allow:false,message}` (`PolicyToolGate.ts:16`) and `ToolGate.decide`'s return
   type has no `updatedInput` channel, so a policy `rewrite` rule (e.g. sanitizing
   a Bash `command`, `policy.ts:115-118`) or a human-edited "ask" approval
   (`PolicyGatewayService.ts:197-198`) is HONORED by SDK (`SdkPermissionBridge.ts:31`)
   and CLI (`auto-allow.sh:44`, `DaemonProxyPolicy.ts:38`) but IGNORED on the API
   lane — the original model input runs. This makes the API lane strictly less
   safe than SDK/CLI for the rewrite behavior. Fix = 2 small changes (§3.1).

4. **Two surface-stripping enforcement points have no API-lane equivalent.** `Task`
   for orchestrators (`ORCHESTRATOR_DISALLOWED_BUILTIN_TOOLS`, `tool-scope.ts:52`)
   and `Workflow` (`tool-scope.ts:26`) are removed via the claude binary's
   `--disallowedTools` / SDK `disallowedTools` (`claude-args.ts:84`,
   `ClaudeSdkBackend.ts:284`) — the API lane has no such flag. `Workflow` +
   `AskUserQuestion` are still gate-denied (in `BLOCKED_BUILTIN_TOOLS`), but
   `Task`-for-orchestrators is NOT in the blocked set, so it must be excluded at
   API-lane surface-build time (dim-2 `buildLaneTooling`), not relied on the gate.

5. **`AskUserQuestion` is hard-denied on the API lane for free** via
   `isBlockedBuiltinTool` inside `makePolicyToolGate` (`PolicyToolGate.ts:14`) AND
   the engine's rung-0 (`PolicyGatewayService.ts:134`) — the same single-source
   deny (`contracts/src/tool-scope.ts:26-43`) used by all five enforcement sites.

**Headline: the new built-in tools get policed correctly almost entirely for
free; close ONE real gap (propagate `updatedInput`/rewrite through the API gate)
plus two surface-construction seams owned by dim 2.**

---

## 2. Current state (what exists today)

### 2.1 The shared decision engine — `PolicyGatewayService.evaluate` (exists)

`core/src/services/PolicyGatewayService.ts`. Pure `core` service; composes ports
(`PendingRepo`, `EventBus`, `Clock`, `PermissionModeResolver`,
`WorkerToolScopeResolver`, `getPolicy()`). Documented Chain of Responsibility
(`:1-9`). The full rung order (`evaluate`, `:125-193`):

```ts
// :134 — rung 0: structural deny, ahead of all user rules / permissive modes
if (isBlockedBuiltinTool(toolName)) return { behavior: "deny", message: blockedBuiltinToolMessage(toolName) };
// :139 — rung 0.5: a subagent (agent_id set) may not drive the Eos control plane
if (agentId && isEosControlTool(toolName)) return { behavior: "deny", message: "... main-agent only ..." };
// :154 — rung 1: worker-definition tool scope (capability boundary), DENY-OR-PASSTHROUGH
const scope = this.deps.toolScopeResolver?.resolveFor(workerId);
if (scope && !isEosControlTool(toolName)) {
  const arg = typeof input.command === "string" ? input.command : undefined;        // :159
  if (matchesAny(toolName, scope.deny, arg)) return { behavior: "deny", ... };       // :160
  if (scope.allow.length > 0 && !matchesAny(toolName, scope.allow, arg)) return ...; // :163
  if (scope.editRegex) {                                                             // :169
    const re = compileEditRegex(scope.editRegex);
    if (re && classifyTool(toolName, input, this.deps.plansDir) === "fileEdit") {     // :171
      const target = input.file_path ?? input.notebook_path;                         // :172
      if (typeof target !== "string" || !re.test(target)) return { behavior:"deny", ... }; // :173
    }
  }
}
// :180 — rung 2: explicit policy.yaml rule match
if (policy.rules.some((rule) => ruleMatches(rule, toolName, input))) return evaluatePolicy(policy, toolName, input);
// :184 — rung 3: per-worker permission mode → category verdict
const mode = this.deps.modeResolver.resolveFor(workerId);
const verdict = MODE_SPECS[mode].decide(classifyTool(toolName, input, this.deps.plansDir));
if (verdict === "allow") return { behavior: "allow", updatedInput: input };          // :187
if (verdict === "deny")  return { behavior: "deny", message: `denied by permission mode: ${mode}` };
return evaluatePolicy(policy, toolName, input);                                       // :192 — rung 4: policy.default
```

Every input read is a **bare name** (`toolName`) or a **canonical input field**
(`input.command`, `input.file_path`, `input.notebook_path`). Nothing reads a
backend descriptor or `kind`. This is exactly why a correctly-named API-lane
built-in is gated identically to the SDK/CLI version.

`decide` (`:78-119`) wraps `evaluate`, emits the `policy` event + `policy:decision`
bus message (`:89-97`), and for an `ask` verdict inserts a pending row and returns
a **Promise that blocks until a human resolves it** via `resolvePending`
(`:99-118`, `:195-215`). The TTL default is 24h (`:103`).

### 2.2 Tool classification & permission modes (exists)

`core/src/domain/permission-mode.ts`:
- Category sets (`:28-31`): `FILE_EDIT_TOOLS={Edit,Write,MultiEdit,NotebookEdit}`,
  `SHELL_TOOLS={Bash,BashOutput,KillBash,KillShell}`, `READ_TOOLS={Read,Glob,Grep,LS}`,
  `NETWORK_TOOLS={WebFetch,WebSearch}`.
- `classifyTool` (`:56-73`): `mcp__*`→`mcp`; file-edit names check
  `input.file_path ?? input.notebook_path` for the plans-dir carve-out →`planFile`,
  else `fileEdit`; else `shell`/`read`/`network`/`other`.
- `MODE_SPECS` (`:80-95`) defines **exactly two** modes: `acceptEdits` (allow
  read/mcp/planFile/fileEdit, else `ask`) and `bypassPermissions` (allow all).
  `PermissionMode` is a **2-value enum** now (`contracts/src/worker.ts:116-119`),
  so `MODE_SPECS` is exhaustive — there is no missing-mode gap. `SqlBackedModeResolver`
  walks `parent_id` and falls back to `acceptEdits` for any unknown/legacy value
  (`SqlBackedModeResolver.ts:29-42`).

### 2.3 Worker-definition tool scope: allow / deny / editRegex (exists)

- Authored schema: `contracts/src/worker-definition.ts` — `toolsAllow?`,
  `toolsDeny?` (string globs), `editRegex?` (`:~33-35`). Materialized `ToolScope`
  = `{allow[], deny[], editRegex|null}` (`:54-59`), baked at spawn into
  `WorkerRow.tool_scope` (JSON, `worker.ts:84`).
- Resolver port: `WorkerToolScopeResolver.resolveFor(workerId): ToolScope|null`
  (`core/src/ports/WorkerToolScopeResolver.ts:7-9`).
- Enforced in the engine at `PolicyGatewayService.ts:154-179` (rung 1, above).
  Glob/command matching via `matchesAny(toolName, patterns, arg)`
  (`core/src/domain/tool-glob.ts`); command-scoped patterns (`Bash(git push:*)`)
  match `input.command`. **Deny-or-passthrough**: scope may DENY but never
  short-circuits ALLOW (so the mode/policy rungs still apply). Eos control tools
  are exempt (`!isEosControlTool(toolName)`, `:155`) so a fenced worker can still
  report back.

### 2.4 policy.yaml: load, compile, match, rewrite (exists)

- Loader: `infra/src/policy/YamlPolicyLoader.ts:17-46` — parses YAML, compiles each
  rule once, default behavior `ask` on parse failure / no file.
- Compile + match: `core/src/domain/policy.ts`. `compileRule` (`:47-82`) builds a
  `toolSet` + per-extra-key `fieldMatchers` (regex over `input[key]`) +
  `rewriteRe`. `ruleMatches` (`:84-94`): tool must be in `toolSet`, then EVERY
  field matcher must `re.test(String(input[key] ?? ""))`. So a rule
  `{tool: Bash, command: "<regex>"}` matches `input.command`.
- `evaluatePolicy` (`:104-124`): first matching rule wins; `allow`→`{allow,
  updatedInput:input}` (`:112`), `deny`→`{deny,message}` (`:113`), `ask`→`{ask}`
  (`:114`), **`rewrite`→`{allow, updatedInput:{...input,[field]:rewritten}}`**
  (`:115-118`, default field `command`).
- Dangerous-command denies are policy.yaml rules, not engine-hardcoded:
  `policy.example.yaml:11-16` blocks `rm -rf /`, `~`, `/Users`, `.claude`, `.eos`.

### 2.5 The three lane gate adapters — same engine, different shells

| Lane | Adapter | Blocked-builtin first? | Propagates `updatedInput`? | Passes `agentId`/`toolUseId`? |
|------|---------|------------------------|----------------------------|-------------------------------|
| claude-sdk | `makeCanUseTool` (`SdkPermissionBridge.ts:22-34`) | yes (`:26`) | **YES** (`:31`) | no (`:29`) |
| API / in-proc | `makePolicyToolGate` (`PolicyToolGate.ts:11-19`) | yes (`:14`) | **NO** (`:16`) | no (`:15`) |
| claude-cli | `auto-allow.sh` hook → `POST /policy/decide`; and/or gateway `mcp__gateway__decide` → `DaemonProxyPolicy` (`gateway/DaemonProxyPolicy.ts:23-26`) | engine rung-0 | **YES** (hook `:44`; proxy `:38`) | hook passes both (`auto-allow.sh:29`); proxy passes `tool_use_id` only (`:26`) |

`PolicyDecider` is the minimal seam (`SdkPermissionBridge.ts:18-20`):
`decide({workerId, toolName, input}) → {behavior, message?, updatedInput?}`. The
container wires ONE `sdkPolicy` over the real engine and propagates `updatedInput`
(`container.ts:728-733`), then hands the **same instance** to the SDK backend
(`:793-799` → `makeCanUseTool` at `ClaudeSdkBackend.ts:285`) and the API/in-process
backends (`:758-765` → `makePolicyToolGate`). So API ≡ SDK at the engine; they
differ ONLY in the adapter shell — and the API shell drops `updatedInput` (§3.1).

The API lane calls the engine **in-process** (a plain function call through
`sdkPolicy`), NOT over HTTP and NOT through the Bun gateway.

### 2.6 The gateway/ Bun service (exists; claude-cli only)

`gateway/server.ts:28-68` — a Bun `McpServer` exposing one tool `decide`, wired to
the claude binary via `--permission-prompt-tool mcp__gateway__decide`. Strategy at
startup (`:18-20`): `DaemonProxyPolicy` when `EOS_DAEMON_URL`+`EOS_WORKER_ID` are
set (forwards to `POST /policy/decide`, `DaemonProxyPolicy.ts:23-26`), else a
`standalonePolicy` with hardcoded Bash safety for daemon-less interactive use.
**The API lane and the SDK lane touch neither the Bun gateway nor the HTTP route**
— they call the in-process engine. The Bun gateway is exclusively a claude-cli
PTY broker; its standalone Bash rules are a separate daemon-less path, not part of
the API lane's threat surface.

### 2.7 Blocked builtins — single source, five enforcement sites (exists)

`contracts/src/tool-scope.ts`: `BLOCKED_BUILTIN_TOOLS=["AskUserQuestion","Workflow"]`
(`:26`), `isBlockedBuiltinTool` (`:41-43`), `blockedBuiltinToolMessage` (`:37-39`),
and the role-scoped `ORCHESTRATOR_DISALLOWED_BUILTIN_TOOLS=["Task"]` (`:52`) +
`disallowedBuiltinToolsFor(isOrchestrator)` (`:57-61`). `AskUserQuestion` is denied
at FIVE sites (all reading the same source):
1. `auto-allow.sh:17` (claude-cli PermissionRequest hook)
2. `PolicyGatewayService.ts:134` (engine rung-0 — covers SDK + API + HTTP)
3. `spawner/worker.ts:617-638` (claude-cli PreToolUse — the only gate under native `bypassPermissions`)
4. `SdkPermissionBridge.ts:26` (SDK canUseTool)
5. `PolicyToolGate.ts:14` (API/in-process gate)

`Workflow` shares these but is primarily removed from the model surface via
`--disallowedTools`/SDK `disallowedTools` (`claude-args.ts:84`,
`ClaudeSdkBackend.ts:284`) so it never reaches the gate on CLI/SDK. `Task` (orch
only) is removed the same way — and is NOT in the gate's blocked set (§3.2).

---

## 3. Gaps & missing pieces (what the API lane needs that isn't there)

### 3.1 GAP — `updatedInput` / policy-`rewrite` is dropped on the API lane (REAL safety regression)

The engine produces `{behavior:"allow", updatedInput}` in four cases; only two
change behavior vs the original input, and BOTH are safety-relevant:
- policy.yaml `action: rewrite` — e.g. sanitize/rewrite a Bash `command`
  (`policy.ts:115-118`).
- a human approving a pending `ask` with EDITED input — carried through
  `resolvePending` (`PolicyGatewayService.ts:197-198`) and persisted as
  `PendingPermissionRow.updated_input` (`worker.ts:135`).
(The other two — `allow`/mode-allow — set `updatedInput: input`, identical to the
original, so dropping them is harmless.)

Honored on SDK (`SdkPermissionBridge.ts:31`: `updatedInput: d.updatedInput ?? input`)
and CLI (`auto-allow.sh:44`; `DaemonProxyPolicy.ts:38`). **Dropped on the API lane**:
`makePolicyToolGate` (`PolicyToolGate.ts:16`) returns only `{allow:true}`, and
`ToolGate.decide`'s return type (`core/src/use-cases/ToolRuntime.ts:21`, per dim 2)
is `{allow:boolean; message?:string}` — no `updatedInput` field — so
`ToolRuntime.executeGated` (`ToolRuntime.ts:110`) runs the model's ORIGINAL input.
Net: a rewrite that neuters a dangerous command, or an operator's manual edit, is
silently ignored on the API lane → strictly less safe than SDK/CLI.

**Concrete change (2 edits, no contract change — `PolicyDecider` already returns `updatedInput`):**
- (a) `core/src/use-cases/ToolRuntime.ts` — extend `ToolGate.decide`'s return to
  `{ allow: boolean; message?: string; updatedInput?: Record<string, unknown> }`,
  and in `executeGated` invoke the tool with `decision.updatedInput ?? input`.
  *(dim-2-owned file — cross-dimension; coordinate with dim 2.)*
- (b) `manager/backends/PolicyToolGate.ts:16` — propagate:
  `d.behavior === "allow" ? { allow: true, updatedInput: d.updatedInput } : { allow:false, message:d.message }`.
- Add a conformance assertion (cross-lane) that a `rewrite` rule changes the input
  the tool receives on the API lane, mirroring SDK.

### 3.2 GAP — orchestrator `Task` exclusion has no API-lane enforcement point

`Task` is removed for orchestrators ONLY (`tool-scope.ts:52`) and ONLY via the
binary's `--disallowedTools`/SDK `disallowedTools` (surface stripping). It is NOT
in `BLOCKED_BUILTIN_TOOLS`, so the engine does NOT deny it — `Task`→`classifyTool`
"other"→ under `bypassPermissions` → ALLOW. The API lane has no `--disallowedTools`
analogue; its model surface is whatever dim-2 `buildLaneTooling` puts in `items`.
**So the orchestrator-`Task` exclusion must be applied at API-lane surface-build
time** by calling `disallowedBuiltinToolsFor(spec.isOrchestrator)` when selecting
built-ins — otherwise an API orchestrator could call `Task` and the gate would let
it through. (`Workflow`/`AskUserQuestion` are belt-and-suspenders: not authored
into the API surface AND gate-denied.) Primary owner: dim 2 (surface), but the
enforcement-relocation is a permission concern flagged here.

### 3.3 GAP — `agentId` (subagent caller-scope deny) never fires on the API lane

`makePolicyToolGate` passes only `{workerId, toolName, input}` — no `agentId`
(`PolicyToolGate.ts:15`). So rung-0.5 ("a subagent may not drive the control
plane", `PolicyGatewayService.ts:139`) never triggers. Harmless today (the API
lane has no native subagents). But when API-lane `Task` is implemented as a nested
`runTurn` sub-agent (dim 2 §3.4 / dim 1), that sub-agent MUST NOT be able to call
`mcp__orchestrator__*` / `mcp__worker__*` control tools. Two options:
- (i) give the nested sub-agent's gate an `agentId` so rung-0.5 denies — needs
  extending `ToolGate`/`makePolicyToolGate` to thread an agent id; OR
- (ii) build the sub-agent's tool surface WITHOUT control tools (natural on the API
  lane, since surface = `buildLaneTooling`). Recommend (ii) as primary + (i) as
  defense-in-depth. Overlaps dim 1 (Task/sub-agent lifecycle).

### 3.4 Non-gap (parity) — `toolUseId` omitted by the API lane

`makePolicyToolGate` omits `toolUseId`, so a pending row created on an API-lane
`ask` has `tool_use_id = null` (`PolicyGatewayService.ts:109`). The SDK lane ALSO
omits it (`SdkPermissionBridge.ts:29`), so this is **parity with SDK, not a
regression** — pending resolution keys on the pending `id`, not `toolUseId`. Only
the claude-cli hook/gateway forward `tool_use_id`. Note for UI correlation only.

### 3.5 Non-gap (good news) — the long-poll "ask" works on the API lane for free

An `ask` verdict makes `PolicyGatewayService.decide` return a Promise that resolves
on human decision (`:116-118`). `makePolicyToolGate` awaits `policy.decide`, and
`ToolRuntime.executeGated` awaits `gate.decide`, so an API-lane turn parks on
operator approval exactly like the SDK's `canUseTool`. The only caveat is the
resolved `updatedInput` being dropped (§3.1).

---

## 4. Design implications & options

### 4.1 The permission stack is reusable as-is — naming is the contract

No new permission wiring is required for the API lane's built-ins. The single
binding requirement (already named by dim 2 §2.6) is **canonical naming**: each
built-in MUST use the exact tool name (`Bash`, `Write`, `Edit`, `MultiEdit`,
`NotebookEdit`, `Read`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`) and exact
input field names (`command`, `file_path`, `notebook_path`, `pattern`, …). Get the
names right and the entire chain in §2.1–§2.4 applies unchanged. Get a name wrong
(e.g. `ShellExec` instead of `Bash`, or `path` instead of `command`) and the tool
silently bypasses category verdicts, editRegex, and command-scoped denies — a
SILENT capability escape, not a loud error. This argues for the single canonical
enum dim 2 proposes, shared by the tools and asserted against
`permission-mode.ts`'s category sets.

### 4.2 Close the `updatedInput` gap by widening `ToolGate`, never by branching

Fix §3.1 by adding the `updatedInput?` field to `ToolGate.decide`'s return and
honoring it in `executeGated` (dim-2 file) + propagating it in `PolicyToolGate`.
This keeps the lanes uniform and adds no `kind` branch (the
`backend-kind-literal-guard` test stays green). It also makes the API `ToolGate`
shape mirror the SDK `PermissionResult` and the CLI hook wrapper — one consistent
"allow-with-optional-rewrite" contract across all three lanes.

### 4.3 Files/ports a design would touch (this dimension)

- `core/src/use-cases/ToolRuntime.ts` — widen `ToolGate.decide` return +
  `executeGated` to apply `updatedInput`. *(coordinate w/ dim 2)*
- `manager/backends/PolicyToolGate.ts:16` — propagate `updatedInput`.
- dim-2 `manager/container.ts` `buildLaneTooling` — apply
  `disallowedBuiltinToolsFor(spec.isOrchestrator)` to the built-in surface (§3.2).
- Reuse UNCHANGED: `PolicyGatewayService`, `permission-mode.ts` (`MODE_SPECS`,
  `classifyTool`), `policy.ts` (`compileRule`/`ruleMatches`/`evaluatePolicy`),
  `WorkerToolScopeResolver`/`PermissionModeResolver`, `tool-scope.ts`, policy.yaml,
  the Bun gateway (untouched — CLI-only).
- New test surface: a cross-lane gating conformance suite (assert API-lane
  Read/Write/Edit/Bash get the SAME verdict as SDK for: editRegex deny, Bash
  command deny, mode `ask`/allow, blocked-builtin deny, rewrite applied).

### 4.4 Cross-dimension seams

- **dim 2 (tool harness/surface):** owns `buildLaneTooling` + the built-in impls;
  must (a) use canonical names/fields (§4.1) and (b) strip orchestrator `Task`
  (§3.2). The `ToolGate` widening (§3.1) is in dim-2's `ToolRuntime.ts`.
- **dim 1 (backend lifecycle / Task):** owns nested-sub-agent `Task` semantics
  → drives the §3.3 control-tool-isolation choice.
- **dim 3 (MCP/skills):** MCP tools (`mcp__server__*`) classify as `mcp` →
  always-allow category (`permission-mode.ts:61`, `:84`); they enter the SAME gate
  with no change. Skills/slash-commands surface as tools too — confirm their
  canonical names with dim 3 so the gate doesn't mis-classify them as `other`.
- **dim 4 (config/model):** API-key/baseURL selection is orthogonal to gating; the
  gate never reads model/provider. No interaction beyond the standalone Bun gateway
  Bash rules (daemon-less, not the API lane).

---

## 5. Open questions / conflicts with sibling dimensions

1. **`ToolGate` ownership for the `updatedInput` fix** — the interface lives in
   dim-2's `ToolRuntime.ts`. Coordinate: does dim 2 widen it, or does this
   dimension? (Recommend dim 2 owns the interface change; this dim owns the
   `PolicyToolGate` propagation + the conformance assertion.)
2. **Nested API-lane `Task` control-tool isolation** (§3.3) — surface-strip vs
   `agentId` propagation. Decision belongs with dim 1; flagged here as a permission
   requirement so it isn't lost.
3. **Canonical tool-name enum** — §4.1 / dim 2 §3.1 both want one source of truth
   for the ~16 names; agree on its home (likely `contracts/`) so `permission-mode.ts`
   category sets, `tool-scope.ts`, and the built-in registry all reference it.
4. **No conflict found with `02-tool-harness.md`.** I CONFIRM its §2.6 claim:
   each built-in call hits policy via `makePolicyToolGate` and bare-name keying
   makes the stack apply for free. I EXTEND it with the `updatedInput`/rewrite gap
   (§3.1), the orchestrator-`Task` surface-enforcement gap (§3.2), and the
   `agentId` sub-agent seam (§3.3) — none of which 02 covered.
5. **Anthropic/OpenAI `tool_use_id` correlation** (§3.4) — confirm with dim 4 /
   dim 1 whether the UI needs `toolUseId` on API-lane pendings; if so the model
   adapters must surface a stable per-call id to thread through `makePolicyToolGate`.
</content>
</invoke>
