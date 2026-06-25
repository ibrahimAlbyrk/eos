# Workflow-System Fixes — File-Level Change Plan (8 items)

Status: DESIGN + RECON ONLY. No code changed except this doc. Branch `feat/eos-workflow-system`.
The workflow engine is already BUILT (commits 233d49a / 823fdac). Every item below is verified
against the REAL code with file:line, then a clean/SOLID change is specified. Two standing
experts ruled on every layer / pattern call: `solid-expert` (clean-arch/SOLID) and
`patterns-expert` (which pattern / extend-the-registry). Their rulings are cited inline as
[SOLID] / [PAT].

Layering recap (lint-enforced): contracts → core → infra → manager → entrypoints. core is pure
(no Node, no Date.now/Math.random — C5). Ports in `core/src/ports`; adapters in `infra/` (pure I/O)
or `manager/` (needs live container services). The StepExecutor registry is the Open/Closed seam.

---

## 0. Map of the built system (what each item touches)

| Layer | Files |
|---|---|
| contracts | `workflow-node.ts` (15-node IR), `workflow.ts` (defn/run/step/tool/step-output schemas), `http.ts` ROUTES (`workflows`, `workflowRun`, `workflowStepOutput`), `loop.ts` (`SpawnLoopSchema`) |
| core ports | `StepExecutor.ts` (+`WorkflowExecCtx`/`NodeResult`/`NodeRunner`), `StepExecutorRegistry.ts`, `WorkerSpawnPort.ts` (`SpawnStepSpec`/`StepOutcome`/`ExpertSpawnSpec`), `WorkflowEngine.ts`, `ProgressSink.ts`, `ConcurrencyGate.ts`, `WorkflowRunRepo.ts`, `WorkflowStepRepo.ts`, `RuntimeWorkflowDefinitionStore.ts`, `WorkflowDefinitionSource.ts` |
| core/workflow | `engine.ts` (Template-Method runNode + run/resume/execute), `registry.ts`, `bindings.ts`, `node-scope.ts`, `predicate.ts`, `concurrency.ts`, `transforms.ts` (`TransformFnRegistry`), `dsl.ts`, `register-builtins.ts`, `executors/{step,sequence,parallel,pipeline,forEach,conditional,loopUntil,phase,subWorkflow,glue,util}.ts` |
| core use-cases | `RunWorkflow.ts`, `ResumeWorkflow.ts`, `StopWorkflow.ts`, `CreateWorkflowDefinition.ts` |
| infra | `SqliteWorkflowRunRepo.ts`, `SqliteWorkflowStepRepo.ts`, `SqliteRuntimeWorkflowDefinitionStore.ts`, `workflow/FileWorkflowDefinitionSource.ts` |
| manager | `services/WorkflowService.ts`, `services/WorkerSpawnAdapter.ts`, `services/EventBusProgressSink.ts`, `services/workflow-rearm.ts`, `services/arm-loop-at-spawn.ts`, `tools/defs/workflow.ts`, `tools/defs/submit_step_output.ts`, `routes/workflows.ts`, `routes/workflow-step-output.ts`, `commands/handlers/spawn-worker.ts`, `container.ts`, `daemon.ts`, `workflows/index.ts` (builtin source), `prompts/role/orchestrator/17-workflows.prompt.md` |

NOTE — the built system is AHEAD of `EOS_WORKFLOW_SYSTEM_DESIGN.md` in several places (the doc's
"v1.x" glue nodes already shipped; `node-scope.ts`, `nodeId` on `SpawnStepSpec`, `item`/`index`/
`resolveDefinition` on the ctx are present). See §11 (discrepancies). Two of the 8 items REVERSE
locked headline decisions of that doc (item 2 deletes `submit_step_output` — design decision
"Typed I/O"; item 7 lets a step loop — design constraint "Report-hold"). Both reversals are
called out where they land.

---

## ITEM 1 — CUSTOM SCRIPT node (trusted local script, hook-style, no agent spawn)

### (a) Current state
No script node exists. The 15 node types (`contracts/src/workflow-node.ts:302-318`) are
`step` + 8 composites + 6 glue. Glue nodes (`map/filter/dedup/tally/accumulate/transform`) name a
PURE fn in the `TransformFnRegistry` (`core/src/workflow/transforms.ts`) and do ZERO I/O — they are
banned from `Date.now`/`Math.random` and Node imports (core purity, C5). There is no port or
executor that runs an external process. The only leaf that reaches outside core is `step`
(`core/src/workflow/executors/step.ts`) via the `WorkerSpawnPort`.

### (b) Clean change — new node + new executor (Strategy) + new core port + infra adapter

[PAT] AGREE: this is a NEW leaf StepExecutor, structurally parallel to `step` (spawn process /
await stdout ↔ spawn worker / await report). It CANNOT be a `TransformFn` — those are pure;
`child_process` I/O violates core purity + C5. This is the canonical node-addition idiom
(Open/Closed): the engine's `runNode` never changes; `register-builtins.ts` gains one line.

[SOLID] Adapter lives in **infra/** (pure process I/O, same family as the existing child_process
adapters). manager owns config RESOLUTION, infra owns the I/O — resolve timeout/cwd at the
composition root and inject them as plain values (exactly how `config.workflow.maxConcurrentSteps`
is resolved by manager and injected as a number into the core `ConcurrencyGate`).

[SOLID] The executor reaches the runner via **factory closure** `makeScriptExecutor(scriptRunner)`
(the `makeTransformExecutor(transforms)` precedent at `register-builtins.ts:31`), NOT a
`WorkflowExecCtx` field. Discriminator: the ctx carries run-scoped concerns EVERY/most executors
need; a dep used by ONE executor and static across runs belongs in the closure (ISP — don't bloat
the ctx every other executor carries).

Files:
- `contracts/src/workflow-node.ts` — add `ScriptNode` interface + `ScriptNodeSchema` + union member
  + `"script"` in `WORKFLOW_NODE_TYPES`. Shape:
  ```ts
  export interface ScriptNode {
    type: "script";
    id: string;
    script: string;        // a NAMED/registered script id OR a path resolved by the runner — see trust gate
    over?: string;         // binding ref → the JSON input (stdin + EOS_NODE_INPUT). Resolves via bindings.
    args?: string[];       // literal argv (binding-resolved), appended after the script
    timeoutMs?: number;    // omitted ⇒ config.workflow.defaultScriptTimeoutMs
  }
  ```
- `core/src/ports/ScriptRunner.ts` — NEW pure port:
  ```ts
  export interface ScriptRunSpec {
    readonly script: string; readonly inputJson: string; readonly args: string[];
    readonly timeoutMs: number; readonly cwd: string;
  }
  export interface ScriptRunResult { readonly stdout: string; readonly exitCode: number; readonly stderr: string; }
  export interface ScriptRunner { run(spec: ScriptRunSpec): Promise<ScriptRunResult>; }
  ```
- `core/src/workflow/executors/script.ts` — NEW `makeScriptExecutor(runner): StepExecutor<"script">`:
  resolve `over` via `ctx.bindings.resolve` → `safeStringify` the bound value as `inputJson`;
  resolve `args`; call `runner.run(...)`; parse stdout as JSON (lenient — fall back to raw stdout
  string); `NodeResult.status = exitCode === 0 ? "passed" : "failed"`. Deterministic glue: NO
  `ctx.concurrency`, NO spawn (it is not an agent and not subject to the worker cap; if desired it
  CAN share the gate, but default no — it is cheap local glue).
- `core/src/workflow/executors/index.ts` + `register-builtins.ts` — export + `registry.register(makeScriptExecutor(runner))`. `registerBuiltinExecutors` gains a `runner` param (defaulted like `transforms`).
- `infra/src/workflow/NodeScriptRunner.ts` — NEW adapter implementing `ScriptRunner` over
  `child_process.execFile`/`spawn`: stdin = `inputJson`, env `EOS_NODE_INPUT=inputJson`, kill on
  `timeoutMs`, capture stdout/stderr/exit. (Mirrors how spawner does PTY I/O — Node-only, infra.)
- `manager/container.ts` — construct `new NodeScriptRunner({ defaultCwd: config.paths.repoRoot })`,
  pass into `registerBuiltinExecutors(workflowRegistry, undefined, scriptRunner)`.
- `manager/shared/config.ts` — `config.workflow.defaultScriptTimeoutMs` (+ `mergeConfig`).
- `manager/prompts/role/orchestrator/17-workflows.prompt.md` — add a `script` row to the node table.

Input/output decisions: INPUT = resolved `over` binding serialized as JSON on BOTH stdin and
`EOS_NODE_INPUT` env (Claude-Code-hook idiom); plus literal `args`. OUTPUT = stdout, parsed as JSON
when it parses else the raw string. TIMEOUT = node `timeoutMs` ?? config default; on timeout the
runner kills and returns nonzero. ERROR = nonzero exit ⇒ `status:"failed"`, stdout/stderr surfaced
in the node output object `{ exitCode, stdout, stderr }` so a downstream `conditional` can branch.

### (c) Interactions / risks
- [PAT] **Trust gate (decisive).** This is NOT the rejected code-exec sandbox (O2) ONLY IF the
  `script` identity comes from a TRUSTED definition source (builtin / author-time / file-based
  `~/.eos/workflows`) — NEVER from an orchestrator/LLM-emitted `run-inline` spec. If the LLM can
  name an arbitrary path/command in a dynamic spec you have reintroduced arbitrary code execution
  in the daemon (holds the OAuth cred, touches FS). REQUIRED: the runner resolves `script` against
  an allowlisted scripts dir (e.g. `~/.eos/scripts/<name>` and builtin), and `run-inline` specs
  containing a `script` node are REJECTED unless the run came from a `run-stored`/builtin/file
  definition. Wire the provenance check in `WorkflowService.run` (it already distinguishes
  `spec` vs `from`).
- **Resume idempotency.** A `passed` script node memo-replays its journaled stdout (engine
  `runNode` memo-check, `engine.ts:68`); but a crash AFTER exec and BEFORE the journal write
  re-executes it → document "script nodes must be idempotent-safe."
- DRY: reuse `safeStringify` (not raw `JSON.stringify`) for input; `e instanceof Error ? … : String(e)` in the adapter catch.

---

## ITEM 2 — OUTPUT = the agent's FINAL response (remove `submit_step_output`)

### (a) Current state
The typed channel exists end to end and the schema path DEPENDS on it:
- Tool `submit_step_output` (`manager/tools/defs/submit_step_output.ts`) → `POST /workers/:id/step-output`
  (`manager/routes/workflow-step-output.ts`) → `WorkerSpawnAdapter.resolveStepOutput`
  (`WorkerSpawnAdapter.ts:141-148`) which PERSISTS then resolves the join with the typed object.
- `step.ts:44-77`: when `outputSchema` is set it tells the worker to call `submit_step_output`
  (`SCHEMA_INSTRUCTION`, line 16), then `schema.safeParse(outcome.output)` — `outcome.output` is
  ONLY ever populated by `resolveStepOutput` (`StepOutcome.output`, `WorkerSpawnPort.ts:38`). If the
  worker never calls the tool, `onReport` resolves with `output:undefined` → `safeParse(undefined)`
  fails → re-prompt loop → after retries returns `status:"failed"`. **This is the stall the item
  describes.**
- Registry: `submitStepOutputDef` in `workerDefs` (`tools/registry.ts:42`).
- ROUTES: `workflowStepOutput` (`http.ts:1740`); schemas `StepResultRequestSchema`/`StepResultResponseSchema` (`workflow.ts:129-135`).

### (b) Clean change — collapse to ONE capture path: the final report text
[PAT] AGREE, net simplification: delete a tool + route + topic + an IPC round-trip; the seam
(registry) is unaffected. [SOLID] remove `output?` from `StepOutcome` (an always-absent optional is
dead surface — ISP/Simplicity-First; re-adding later is a trivial additive change).

The `worker:report` bus event ALREADY carries the report `text` (`workers.ts:592`) and the adapter's
`onReport` ALREADY resolves a no-schema step from it (`WorkerSpawnAdapter.ts:221-231`). So the new
capture path is: EVERY step resolves from the report text; when `outputSchema` is set, extract+parse
JSON FROM that text.

Files:
- DELETE `manager/tools/defs/submit_step_output.ts`; remove from `tools/registry.ts:42` (workerDefs).
- DELETE `manager/routes/workflow-step-output.ts`; remove `registerWorkflowStepOutputRoute` from `daemon.ts:99`.
- `contracts/src/http.ts` — remove `ROUTES.workflowStepOutput` (1740) + its comment.
- `contracts/src/workflow.ts` — remove `StepResultRequestSchema`/`StepResultResponseSchema` (129-135).
- `core/src/ports/WorkerSpawnPort.ts` — remove `output?` from `StepOutcome` (38); the port now
  exposes only `{ workerId, signal, reportText }`.
- `manager/services/WorkerSpawnAdapter.ts` — remove `resolveStepOutput` (141-148) and the `steps`/
  `setOutput`/`setStatus` writes it did; `onReport` resolves `{ workerId, signal, reportText }`.
  (Durable persistence still happens — see risks.)
- `core/src/workflow/executors/step.ts` + `util.ts` — new flow when `outputSchema` set:
  1. `SCHEMA_INSTRUCTION` becomes: *"End your final report with the result as JSON matching the
     schema, in a fenced ```json block."*
  2. After the join, run a PURE extractor [PAT — Tolerant Reader, a single helper in `util.ts`, NOT
     a Strategy hierarchy]: `extractJson(reportText)` → first fenced ```json block, else first
     balanced `{...}`/`[...]`, returns `{ value, found }`.
  3. `schema.safeParse(value)` → on success `status:"passed"`, output = parsed.
  4. On failure re-prompt ONCE (not the current bounded-N loop — item says "re-prompt ONCE").
  5. NEVER stall: worst case `output = raw reportText`, but [PAT correctness] mark
     `status:"failed"` (or a "degraded" flag) so downstream observers see it never validated rather
     than treating raw prose as a typed object.
- `manager/prompts/role/orchestrator/17-workflows.prompt.md` — rewrite line 74 + the `step` row to
  describe "final report = output; outputSchema ⇒ end the report with a ```json block" and drop all
  `submit_step_output` mentions.

### (c) Interactions / risks — THIS REVERSES A LOCKED DESIGN DECISION
- [SOLID — arch flag] This re-opens the exact §2.2 "no typed-result channel" gap that
  `submit_step_output` was built (design decision "Typed I/O", §3.6) to close. Schema validation now
  runs against free text the agent wrote (fragile). **Make the product call explicit:** the item's
  premise is that the tool STALLS (true — see (a)); the fix removes the stall by never requiring the
  tool, at the cost of typed-binding robustness. RECOMMENDED stance: accept it — the lenient
  extract + re-prompt-once + raw fallback preserves "typed when the agent complies, never wedged
  when it doesn't," which is strictly better than today's stall.
- [PAT correctness] Raw-text fallback means a binding can be a STRING where a downstream
  `{{nodes.x.output.field}}` expects an object → silent `undefined`. Mitigate by surfacing the
  parse outcome in `NodeResult.status` (above) so the run fails loudly instead of feeding prose.
- **Durable persistence after removing `resolveStepOutput`.** Today `resolveStepOutput` persisted
  the step output before resolving. After removal, persistence falls to the engine Template Method
  (`engine.ts:86-93` upserts status+output AFTER `execute` returns) — this ALREADY happens for the
  text path, so no new write is needed. Crash-window recovery still works: the report route
  dispatches a `worker_report` event + queued envelope under the anchor, and `workflow-rearm.ts`
  `recoverReport` reads exactly those (`workflow-rearm.ts:79-101`). So the rearm path is unchanged.
- **Reconciles with item 7:** the loop-released report text becomes the step output through the
  SAME `onReport` path — one capture path for normal, looped, and schema steps.

---

## ITEM 3 — "message area" for ALL workflow tools (CLARIFY-PENDING — flagged)

### (a) Current state — house convention (surveyed)
`ToolDefinition.handler` returns `Promise<unknown>` (`manager/tools/types.ts`); the projection layer
coerces: a string passes through, an object is `JSON.stringify(_, null, 2)`'d into a single MCP text
block (`shared/mcp-tool.ts` `safeText`). There is NO shared result-formatter. Two house idioms:
- **Side-effect-only tools → a one-line English string:** `send_message_to_parent` → "Message
  delivered to orchestrator."; `submit_step_output` → "Step output recorded."
- **Query/launch tools → a structured object** (JSON): `spawn_worker` → `{id,port,name}`;
  `list_active_workers` → array of lean rows; `integrate_workers` → `{ok, message, workers, …}` with
  a human `message` field. Transient/error states return multi-sentence guidance strings
  (`ask_peer`, `list_peers`, `ask_user`).

The `workflow` tool today (`manager/tools/defs/workflow.ts:56`) returns the raw HTTP response object
verbatim (`{runId, status}` / `{name}`), with no human line — inconsistent with the launch-tool
idiom that pairs structured fields with a readable summary (cf. `integrate_workers.message`).

### (b) Recommended change (content/format reading)
Keep returns structured BUT add a leading human line, mirroring `integrate_workers`:
- `run-stored`/`run-inline` → `{ runId, status, message: "Workflow run <id> started (status: running). Poll with workflow {mode:'status', runId} or stop it." }`
- `create` → `{ name, message: "Workflow '<name>' saved. Run it with workflow {mode:'run-stored', from:'<name>'}." }`
- `status` → echo the run row's `{runId, status, result?}` + one-line summary.
- `stop` → `{ runId, status, message: "Run <id> stopped; its worker subtree was reaped." }`
This lands in `manager/tools/defs/workflow.ts` (shape the returned object after `ctx.api`), needs no
route change, and matches the surveyed convention. No shared formatter is warranted (the house style
is per-tool). Item 8 (completion message) is the OTHER half: status arrives as a chat message at
completion, so the tool result only needs the "started/poll" framing, not a completion echo.

### (c) OPEN QUESTION (record, do not resolve)
"Message area" is ambiguous between (i) the **tool-result CONTENT** the orchestrator agent reads
(designed above) and (ii) an **app/dashboard UI render** of run/step progress. The design doc puts
UI explicitly OUT OF SCOPE (§ top; progress already streams via `workflow:run-change` /
`workflow:step-change` → SSE for a future view). RECOMMENDATION: implement (i) now (cheap, agent-
facing, consistent); DEFER (ii) to the UI workstream. **Needs the operator's read on which "message
area" was meant before building any UI surface.** This is the item flagged clarify-pending.

---

## ITEM 4 — workflow steps can't reach `create_worker` runtime defs

### (a) Current state — CONFIRMED root cause
- A step spawns through `runStepSpawn` → `spawnWorkerHandler.run` with `parentId = anchorId`
  (`container.ts:924-927`; `WorkerSpawnAdapter.stepRequest` sets `parentId: spec.parentId` =
  `ctx.anchorId`, `WorkerSpawnAdapter.ts:214`).
- The handler resolves runtime defs by OWNER: `...(body.parentId ? c.runtimeWorkerDefinitions.listFor(body.parentId) : [])` (`spawn-worker.ts:51-54`).
- `create_worker` keys runtime defs by the orchestrator's `selfId`:
  `POST /worker-definitions?owner=<ctx.selfId>` → `runtimeWorkerDefinitions.create(owner, def)`
  (`tools/defs/create_worker.ts:26`; `routes/worker-definitions.ts:34-40`; store keyed by `(owner,name)`,
  `SqliteRuntimeWorkerDefinitionStore.ts:36/45`).
- For a workflow step, `body.parentId = anchorId` (the synthetic run-anchor row id = runId), which is
  NOT the orchestrator selfId. So `listFor(anchorId)` returns `[]` → the orchestrator's `create_worker`
  defs are invisible to its own workflow's steps. **Confirmed.**
- The owner IS recoverable: the anchor row's `parent_id` column = the orchestrator selfId
  (`WorkerSpawnAdapter.mintRunAnchor` sets `parentId: ownerId`, `WorkerSpawnAdapter.ts:185`).

### (b) Clean change — thread the run owner explicitly
[SOLID] Option (a): add an explicit, domain-neutral `definitionOwnerId` to the spawn request; the
handler resolves `listFor(req.definitionOwnerId ?? body.parentId)`. REJECT the alternative
(handler walks `parent_id` when it sees an `is_orchestrator` anchor) — that embeds workflow-anchor
topology into the generic `spawnWorkerHandler` (leaky abstraction + SRP: the handler would change
for spawn AND for anchor design). Keep anchor→owner knowledge in the workflow adapter that owns it.

Files:
- `contracts/src/http.ts` — add `definitionOwnerId?: string` to `SpawnWorkerRequest` (optional; the
  normal spawn path leaves it unset → behavior unchanged).
- `manager/commands/handlers/spawn-worker.ts:51-54` — change the runtime overlay to:
  ```ts
  const defOwner = body.definitionOwnerId ?? body.parentId;
  const records = [
    ...c.listWorkerDefinitionRecords(lookupCwd),
    ...(defOwner ? c.runtimeWorkerDefinitions.listFor(defOwner) : []),
  ];
  ```
- `core/src/ports/WorkerSpawnPort.ts` — add `definitionOwnerId: string` to `SpawnStepSpec` and
  `ExpertSpawnSpec` (the run owner; experts should resolve the same defs).
- `core/src/ports/StepExecutor.ts` — `WorkflowExecCtx` gains `readonly ownerId: string`
  (the engine HAS it — `RunContext.ownerId` — but does not currently put it on the exec ctx).
- `core/src/workflow/engine.ts:138-155` — set `ownerId: ctx.ownerId` on the `execCtx`.
- `core/src/workflow/executors/step.ts:46-59` — pass `definitionOwnerId: ctx.ownerId` into `SpawnStepSpec`.
- `manager/services/WorkerSpawnAdapter.ts` — `stepRequest` (204-219) and `spawnExpert` (150-164)
  forward `definitionOwnerId: spec.definitionOwnerId` onto the `StepSpawnRequest`.
- `core/src/workflow/engine.ts:131-136` — `spawnExpert(... definitionOwnerId: ctx.ownerId)`.

### (c) Interactions / risks
- Precedence: runtime defs already win over disk in `resolveWorkerDefinitionByName` (last-match).
  Threading the owner only widens the candidate set; nearest-wins is preserved.
- Project-dir lookup: `lookupCwd` is derived from the step's `worktreeFrom`/`cwd`
  (`spawn-worker.ts:47`); steps run in a worktree off `config.paths.repoRoot`, so project `.eos/workers`
  resolution is unaffected.
- This also fixes EXPERT spawns silently missing the orchestrator's `create_worker` definitions for
  their `from:` — same root cause, same fix (experts spawn under the anchor too).

---

## ITEM 5 — list available WORKFLOWS in the orchestrator prompt (mirror the worker list)

### (a) Current state
The available-WORKERS list is injected via DPI: `container.ts:606-610` computes
`renderWorkerDefinitionCatalog(mergeAvailableWorkers(listWorkerDefinitionRecords(lookupCwd), runtimeWorkerDefinitions.listFor(id)))`
and passes it as `workerDefinitionCatalog` into `assembleSystemPrompt`; `AssembleSystemPrompt.ts:96-111`
maps it to the `AVAILABLE_WORKERS_CATALOG` template var; the fragment
`prompts/role/orchestrator/16-available-workers.prompt.md` renders `{{#if AVAILABLE_WORKERS_CATALOG}}…`.
There is NO equivalent for workflows — the orchestrator only learns the two builtins from static
prose in `17-workflows.prompt.md:48`. The overlay resolver already exists for workflows
(`container.ts:901-916` `resolveWorkflowDefinition`: builtin + file + `runtimeWorkflowDefinitions.listFor(ownerId)`).

### (b) Clean change — mirror the worker-catalog DPI exactly
[PAT] AGREE exactly; the list MUST be dynamic (it changes at runtime via `create_workflow`). Files:
- `manager/container.ts` (near 606) — add, for `role==="orchestrator"`:
  ```ts
  const workflowDefinitionCatalog = role === "orchestrator"
    ? renderWorkflowDefinitionCatalog([
        ...builtinWorkflowDefinitions.list(),
        ...new FileWorkflowDefinitionSource(user+projectDirs).list(),
        ...runtimeWorkflowDefinitions.listFor(id),
      ])
    : "";
  ```
  (reuse the same source list `resolveWorkflowDefinition` builds; factor a small
  `listWorkflowDefinitionRecords(cwd, ownerId)` helper to avoid duplicating the dir logic — DRY).
- `core/src/domain/workflow-definition-catalog.ts` — NEW (clone `worker-definition-catalog.ts`):
  `renderWorkflowDefinitionCatalog(records)` → one line per workflow: `- <name>: <description>` (+
  arg hint if `argsSchema`), and a `mergeAvailableWorkflows` if needed (the resolver already does
  last-wins; a render-only helper may suffice).
- `core/src/use-cases/AssembleSystemPrompt.ts` — add `workflowDefinitionCatalog` to
  `SessionSpawnContext` + `AVAILABLE_WORKFLOWS_CATALOG: ctx.workflowDefinitionCatalog ?? ""` in `sessionVars`.
- `manager/container.ts` `assembleSystemPrompt(...)` call — pass `workflowDefinitionCatalog`.
- NEW fragment `prompts/role/orchestrator/18-available-workflows.prompt.md` — frontmatter
  `when: { fact: role, eq: orchestrator }` (session-immutable — DPI-legal), body
  `{{#if AVAILABLE_WORKFLOWS_CATALOG}}{{AVAILABLE_WORKFLOWS_CATALOG}}{{/if}}`. Priority just after
  16/17 (e.g. 155).

### (c) Interactions / risks
- Cohabits with item 6 (same fragment family); keep the LIST (item 5, dynamic) separate from the
  VOCABULARY (item 6, mostly static) so each has one reason to change.
- The catalog is computed at spawn from session-immutable `role` only; no mutable-fact gating (DPI rule honored).

---

## ITEM 6 — enrich the orchestrator prompt with the engine's full capability catalog

### (a) Current state
`17-workflows.prompt.md` hand-lists the node table (54-65) and the predicate grammar (67) as static
prose, and names a FEW transform fns implicitly. It does NOT enumerate the registered transform-fn
names, and the node table is a hand-maintained copy of the registry — it WILL drift when an executor
or fn is added in `register-builtins.ts` / `transforms.ts`. The registry exposes introspection:
`StepExecutorRegistry.types()` (`StepExecutorRegistry.ts:13`) and `TransformFnRegistry.names()`
(`transforms.ts:38`).

### (b) Clean change — derive-and-inject the NAME catalogs; author the PARAM prose
[PAT] REFINE the static/dynamic split — the right axis is Single-Source-of-Truth/DRY, not
text-vs-injection:
- **Node-type NAMES + transform-fn NAMES → DERIVE from `registry.types()` / `transforms.names()` at
  composition and INJECT as a computed var.** They are fixed per daemon-lifetime, but hardcoding
  them duplicates the registry and the prompt LIES the moment someone adds an executor or a custom
  fn in `container.ts`. (Directly answers the sub-question: YES, inject `transforms.names()` — the
  composition root can seed custom fns, so a hardcoded list silently drifts.)
- **Per-node PARAMS / semantics / usage guidance → authored static prose** in `17-workflows.prompt.md`
  (the registry yields only the type string; do NOT build Zod→prose generation — over-engineering for v1).
- **Available-workflows LIST → dynamic per-spawn** (item 5).

Files:
- `manager/container.ts` — compute `workflowCapabilityCatalog` = `renderCapabilityCatalog(workflowRegistry.types(), workflowTransforms.names())` (the `registerBuiltinExecutors` return already hands back `{ transforms }`; capture it). Inject as a template var.
- `core/src/use-cases/AssembleSystemPrompt.ts` — add `WORKFLOW_CAPABILITY_CATALOG` var (node-type
  names + transform-fn names, comma-joined or bulleted).
- `manager/prompts/role/orchestrator/17-workflows.prompt.md` — keep the param/semantics prose;
  REPLACE the bare name enumerations with `{{WORKFLOW_CAPABILITY_CATALOG}}` so the canonical list is
  registry-derived; keep the predicate grammar + bindings prose static.

### (c) Interactions / risks (esp. 5↔6)
- 5 and 6 are SEPARATE injected vars (LIST vs VOCABULARY) — do not fuse them; different change
  cadence (per-create vs per-deploy).
- If item 1 lands, `script` appears automatically in `registry.types()` → the catalog self-updates
  (proves the anti-drift value). Param prose for `script` is still authored (item 1 already adds the row).
- Cost: the vocabulary catalog is short (≤21 names); negligible prompt budget.

---

## ITEM 7 — let a workflow STEP arm the existing `dynamic_loop`

### (a) Current state — and the locked decision it reverses
- `StepNode` has no `loop` field (`workflow-node.ts:46-58`). The design doc LOCKED "step-workers must
  NOT arm their own loops — the workflow IS the control loop; use `loopUntil`" (§3.4 Report-hold,
  §7). `17-workflows.prompt.md:62` states this to the orchestrator.
- `spawn_worker` already supports `loop?: SpawnLoop` (`http.ts:59`); `spawnWorkerHandler` arms it via
  `armLoopAtSpawn` (`spawn-worker.ts:34-37, 168-173`) — requires `config.loop.enabled` + `body.parentId`.
  A step has `parentId = anchorId` (parented), so the precondition is satisfiable.
- THE GAP (verified): a looped worker's report is HELD — the report route runs `reportHoldGate`
  (`workers.ts:588`) and publishes `worker:report{held:true}` (line 592), then short-circuits without
  dispatching. The adapter's `onReport` sees `held` and DOES NOT resolve (`WorkerSpawnAdapter.ts:227`,
  it sets `sawReport=true` and waits). The loop RELEASE goes `runLoopTick`
  (`core/src/use-cases/runLoopTick.ts:96/113`) → `deps.releaseReport` → the daemon closure
  (`daemon.ts:144-156`) which calls `dispatchMessage` DIRECTLY to the parent — it **never
  re-publishes `worker:report` on the bus.** So the workflow join would wait forever. **This is the
  real work of item 7**, not the field-threading.

### (b) Clean change — two parts
PART A (thread the loop field):
- `contracts/src/workflow-node.ts` — add `loop?: SpawnLoop` to `StepNode` + `StepNodeSchema`
  (import `SpawnLoopSchema` from `loop.ts`).
- `core/src/ports/WorkerSpawnPort.ts` — add `loop?: SpawnLoop` to `SpawnStepSpec`.
- `core/src/workflow/executors/step.ts:46-59` — pass `loop: node.loop` into the spec.
- `manager/services/WorkerSpawnAdapter.ts:204-219` — `stepRequest` forwards `loop: spec.loop` onto
  the `StepSpawnRequest` (the handler already arms it). No change to `spawn-worker.ts` arming logic.

PART B (bridge loop-release → the workflow join):
[PAT] option (a) — and it COMPLETES a half-built design, not a hack: `workers.ts:586-592` ALREADY
publishes `worker:report` with a `held` flag explicitly "for the workflow step-join," and the adapter
ALREADY ignores `held:true`. The release path just needs to emit the TERMINAL
`worker:report{held:false, released:true}` from the ONE `releaseReport` chokepoint:
- `manager/daemon.ts:144-156` `releaseReport` — BEFORE (or alongside) the `dispatchMessage`, add
  `c.bus.publish("worker:report", { workerId, parentId, text, held: false })`. The adapter's existing
  `onReport` then resolves the join with `signal = classifyReport(text)` and `reportText = text`
  (the released text = the step output — consistent with item 2).
- REJECT option (b) (a new `loop:released` topic) — it duplicates a distinction the `held` flag
  already encodes; fresh machinery for a semantic the existing event carries.

### (c) Interactions / risks (esp. 2↔7)
- [PAT 7a — JUSTIFICATION, record it] Adding `loop` to a step REVERSES the locked "no step loops"
  decision. The HONEST justification (and the only one): `loopUntil`'s stop condition is a PURE
  Specification predicate (`eq/exists/and/or` over bindings, `predicate.ts`) and CANNOT express a
  SEMANTIC "good enough, judged by an LLM" stop; `dynamic_loop`'s `GoalCheckStrategy`
  (command/judge/hybrid) CAN. So: a STRUCTURAL stop → keep using `loopUntil`-over-a-single-step (no
  new field); a SEMANTIC judge stop → item 7 is the DRY choice (reuse `dynamic_loop` rather than
  rebuild judge machinery inside `loopUntil`). Update `17-workflows.prompt.md:62` to draw exactly
  this line instead of the blanket prohibition.
- Blast radius of the republish [PAT — VERIFIED nil]: `worker:report` has exactly ONE subscriber
  (the adapter) and ONE publisher (the report route); adding a publish at `releaseReport` reaches
  only the adapter. No double-dispatch to the parent — parent delivery is the direct `dispatchMessage`
  already inside `releaseReport`, not a bus subscription.
- 2↔7 reconciliation: with item 2, the released report TEXT is the step output through the SAME
  `onReport` path. If the looped step has an `outputSchema`, the lenient extractor (item 2) runs on
  the released text — works unchanged.
- Anchor dispatch: `releaseReport` will also `dispatchMessage` the released text to `parentId =
  anchorId` (a synthetic, non-resumable row). Harmless: `resumeIfDead` no-ops on a non-resumable
  anchor, and the queued envelope under the anchor is the SAME durable trace `workflow-rearm.ts`
  recovery reads. No suppression needed.
- Guard: arming requires `config.loop.enabled` (`spawn-worker.ts:35`) — document that a step `loop`
  needs the loop subsystem enabled, else the spawn throws (fail-fast before the worker is created).
- Persist-on-release: the engine Template Method journals after `execute` returns (item 2's path);
  crash-window recovery covered by the anchor's `worker_report` event / queued envelope.

---

## ITEM 8 — on completion, deliver the FULL result to the run owner as a message

### (a) Current state
The `workflow` tool is fire-and-forget: `WorkflowService.run` returns `{runId, status:"running"}`
immediately and voids the run promise (`WorkflowService.ts:77-84`). On completion the engine only
sets the run row + publishes progress (`engine.ts:158-161` → `progress.runChanged` → SSE). The
orchestrator gets NO message; it must poll `workflow {mode:"status"}`. The run owner = the
orchestrator selfId, available as `ownerId` in `WorkflowService.run` and on the run row (`row.owner`).
The delivery primitive exists: `dispatchMessage` (core use-case) called with `dispatchDeps(c)`,
`queueWhenBusy:true`, an envelope `{kind:"worker_report"|"orchestrator_message"}`; the report route
and the loop `releaseReport` both use it (`workers.ts:640`, `daemon.ts:148`).

### (b) Clean change — manager-side `.then` dispatch (no new core port)
[SOLID] option (a): chain the dispatch in `WorkflowService.run`'s promise. The manager already holds
both the returned `{runId,status,output}` AND `dispatchMessage` — deliver from data in hand, zero new
ports. REJECT (b) a `RunCompletionSink` core port (speculative DIP machinery — makes the engine own
an outbound owner-notification concern it doesn't need; the manager observes completion as the
resolved promise). REJECT (c) overloading `ProgressSink` (SRP/ISP — it is the broadcast Observer
for lifecycle→SSE; owner delivery is a one-shot DIRECTED dispatch, a different reason to change).

Files:
- `manager/services/WorkflowService.ts` — add a `deliverCompletion(ownerId, result)` dep to
  `WorkflowServiceDeps`; in `run` change the fire-and-forget chain to:
  ```ts
  void runWorkflow(...)
    .then((result) => this.deps.deliverCompletion(ownerId, result))   // passed AND failed
    .catch((e) => { this.deps.log.warn(...); /* optionally deliver a failure note */ })
    .finally(() => this.controllers.delete(runId));
  ```
  Apply the same to `resume` (a re-armed run that completes should also notify `row.owner`).
- `manager/container.ts` (WorkflowService wiring, 953-963) — wire `deliverCompletion`:
  ```ts
  deliverCompletion: (ownerId, result) => void dispatchMessage(dispatchDeps(c), {
    workerId: ownerId,
    text: renderWorkflowCompletion(result),     // full result, formatted
    displayText: renderWorkflowCompletion(result),
    envelope: { kind: "worker_report", fromWorker: result.runId, workerName: "workflow" },
    queueWhenBusy: true,
    origin: "workflow-completion",
  }).catch((e) => log.warn("workflow completion dispatch failed", { error: errMsg(e) })),
  ```
  (`renderWorkflowCompletion` = a small manager helper: `[workflow <runId>] completed (status:
  <status>):\n<safeStringify(result.output)>`.)

### (c) Interactions / risks
- [SOLID — behavior call] `.then` fires for BOTH `passed` and `failed` (`runWorkflow` returns on
  both); `.catch` only for an unexpected THROW or abort. Decide explicitly:
  - passed/failed → deliver the full result (status carried in the text).
  - explicit `stop` (user-initiated) → the controller is aborted; the run promise rejects → hits
    `.catch`. RECOMMEND: do NOT notify on user-initiated stop (the operator already knows); DO
    notify on an unexpected throw with a `failed:`-style line.
- `queueWhenBusy:true` serializes the completion behind any in-flight orchestrator turn (FIFO),
  exactly like worker reports — no special-casing.
- The owner may be a claude-sdk (port-less) orchestrator; `dispatchMessage` already handles that via
  the backend (the report route relies on the same path — `workers.ts:634-640`).
- Idempotency: pass a stable `clientMsgId` (e.g. `wf-complete:<runId>`) so a re-arm that re-completes
  a run does not double-deliver (UNIQUE(worker_id, client_msg_id)).
- Tool-result framing (item 3) should say "poll/await the completion message," since the result now
  arrives as a message.

---

## 9. Cross-item interactions (summary)

- **2 ↔ 7**: one capture path. Normal, looped-released, and schema steps all resolve through the
  adapter's `onReport(text)`; the lenient extractor (item 2) runs on whatever text arrives (direct
  or loop-released). Build item 2 first so item 7's released-report path has the final shape.
- **2 ↔ 8**: item 2 makes `result.output` the (possibly text) final result; item 8 ships exactly
  that to the owner. The completion message and the per-step capture share the report-text semantics.
- **4 ↔ 1/7**: item 4 (owner-scoped def resolution) makes a `from:` in a `script`/looped step
  resolve the orchestrator's `create_worker` defs — without it, step `from:` references to
  runtime-defined workers fail. Land item 4 early.
- **5 ↔ 6**: separate injected vars (LIST vs VOCABULARY); item 1 auto-extends item 6's name catalog.
- **1 trust ↔ 3 open**: both are gated on a human decision (script provenance policy; "message area"
  meaning). Surface both before building their risky halves.

## 10. Dependency-ordered implementation sequencing (work units)

Each unit is independently shippable and ordered so earlier units unblock later ones. Contracts-first
within each unit (contracts → core → infra → manager), per the lint-enforced direction.

1. **WU-4 (owner-scoped defs)** — smallest, unblocks `from:` in every later step. contracts
   (`definitionOwnerId`) → core (ctx.ownerId, SpawnStepSpec) → manager (handler overlay, adapter,
   engine ctx). Verify: a step `from:`-references a `create_worker` def and resolves.
2. **WU-2 (final-response output)** — removes `submit_step_output` end-to-end; rewrites `step.ts`
   capture + the prompt. Do BEFORE 7/8 so the report-text capture path is canonical. Verify: a step
   with/without `outputSchema` produces output; a non-JSON final report falls back to raw text +
   `failed` status; no `submit_step_output` references remain (grep + tsc + lint).
3. **WU-7 (step loop)** — depends on WU-2 (released text = output). PART A field-threading +
   PART B `releaseReport` bus republish. Verify: a step with `loop` holds its first report, releases
   on goal-met, and the join resolves with the released text.
4. **WU-8 (completion → owner)** — depends on WU-2 (result shape). `WorkflowService` `.then` +
   container `deliverCompletion`. Verify: a completed run delivers a message to the owner;
   user-`stop` does not.
5. **WU-1 (script node)** — independent of 2/7/8; needs WU-4 only if a script-bearing flow also uses
   runtime defs. contracts (ScriptNode) → core (port + executor) → infra (NodeScriptRunner) →
   manager (container wiring, config, trust gate in `WorkflowService.run`, prompt row). Verify: a
   builtin/file script node runs and captures stdout; an inline-spec script node is rejected.
6. **WU-5 (workflows list)** + **WU-6 (capability catalog)** — prompt/DPI only, no engine change;
   land together (same fragment family). WU-6 auto-includes WU-1's `script` if 1 shipped. Verify:
   spawn an orchestrator, assert the assembled prompt contains the workflow list + the registry-
   derived name catalog.
7. **WU-3 (tool result messages)** — last; pure `tools/defs/workflow.ts` return shaping. Land after
   WU-8 so the "poll/await completion" framing matches. Verify by reading the returned strings.
   **Hold the UI half pending the clarify-pending answer.**

Verification harness for every unit: `cd manager && npm test` (engine/adapter/rearm suites + core +
spawner), `cd contracts && npm test`, `npm run lint` (dependency-direction + backend-kind guard).
Do NOT `eos build` / `eos restart` (crashes running workers).

## 11. Current-code-vs-design-doc discrepancies (flagged)

1. **Glue nodes shipped in v1.** The doc files `map/filter/dedup/tally/accumulate` as v1.x
   (§3.2/§6) — but the built union already has all six glue types + `transform`
   (`workflow-node.ts:107-145`) via `glue.ts` factories. Code is AHEAD of the doc.
2. **`submit_step_output` is built and on the critical path** (design "Typed I/O", §3.6) — item 2
   DELETES it. The plan reverses a locked headline decision; recorded in item 2(c).
3. **"Step-workers must NOT arm loops"** (§3.4/§7 Report-hold) — item 7 reverses it; justification
   (semantic judge-stop vs structural `loopUntil`) recorded in item 7(c).
4. **Engine ctx evolved past the doc.** `WorkflowExecCtx` now carries `item`/`index`/
   `resolveDefinition` (`StepExecutor.ts:54-60`) not in the doc's §3.13 interface; `SpawnStepSpec`
   carries `nodeId` (`WorkerSpawnPort.ts:16`) for durable persistence. Item 4 adds `ownerId` to the
   same ctx — note the ctx is the established place to thread run-scoped facts.
5. **`node-scope.ts` (per-iteration id scoping)** exists (the doc's "P2 flagged concern") but is not
   in the doc's §3.12 module layout. Relevant to item 7: a looped step inside a `forEach`/`pipeline`
   gets id-suffixed bodies; the `loop` field rides on the cloned step node fine (it is copied by the
   `{...node}` spread in `rewriteNode`).
6. **`description`/`experts` are `.optional()` not `.default()`** (`workflow.ts:30-36`) — a
   self-documented deviation from §4.4 (CommandDef input===output constraint). No action; items add
   `loop?`/`script` as plain optionals consistent with this.
7. **`WorkerSpawnAdapter.resolveStepOutput`** is an adapter method NOT on the `WorkerSpawnPort`
   (called directly by the step-output route) — item 2 removes both. The port stays clean.
