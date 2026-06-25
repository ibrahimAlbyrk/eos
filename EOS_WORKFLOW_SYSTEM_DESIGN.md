# Eos Workflow-Orchestration System — Implementation-Grade Design

Status: design synthesis (code-first engine). **UI / visualization is explicitly OUT OF
SCOPE** — this document specifies the deterministic engine, its contracts, persistence,
and integration only. The web UI gets run/step state "for free" through the existing
EventBus→SSE pipe (see §3.7), but no view, component, or visualization is designed here.

This report is synthesized from four specialist research findings (cited in the Appendix)
plus direct follow-up consultation with all four authors, who remain consultable peers.
Every Eos path/signature below was read from the repo at branch `dev`.

---

## 1. Executive summary

We are building a **deterministic, code-defined workflow-orchestration engine** that runs
**inside the Eos daemon** and drives Claude **worker agents** through multi-step flows
(fan-out / fan-in, pipelines, conditionals, data-driven loops), with typed step I/O,
crash-safe persistence, and a first-class **standing expert-worker pool** that other
workers consult on demand.

The engine reuses Eos's real spawn surface (`spawnWorkerHandler` → `spawnWorker`), its
EventBus, its SQLite/WAL persistence, and its peer-mesh — cloning the established
**dynamic-loop subsystem** (`worker_loops`) and **worker-definition trio** as precedent
rather than inventing new idioms.

### Headline decisions (all locked)

| # | Decision | Resolution |
|---|---|---|
| **C1** | Code-DSL vs declarative IR for the **dynamic** (orchestrator-generated) path | **Declarative `WorkflowNode` IR is the single execution target.** The code DSL survives only as a **trusted, author-time Builder** that lowers to the *same* IR. No public code-exec path in v1. *(§3.2)* |
| **Typed I/O** | `submit_step_output` MCP tool + step-output route + Zod, vs free-text parsing | **Build `submit_step_output`** (tool + `POST /workers/:id/step-output` + Zod validate-with-retry). It is on the critical path. **Fallback** when a step declares no `outputSchema`: the existing report-text path via `classifyReport()`. *(§3.6)* |
| **Resume** | journal-only-v1 / replay-v1.x | **Revised upward:** durable per-step result persistence + boot reconciliation are **mandatory in v1** (crash-correctness, not a luxury — `worker:report` is ephemeral and a resumed worker never re-reports). Only **auto-continue** of a half-finished run is the v1.x fast-follow. *(§3.7)* |
| **C4** | Run anchor identity | **A synthetic anchor worker-row** per run (`WorkerRepo.insert`, `parentId = orchestrator selfId`, `is_orchestrator=1`, null pid/port/session). Scopes the mesh to exactly this run, enables one-call subtree teardown, preserves ownership + mode inheritance. *(§3.5, §4)* |
| **C5** | Determinism guard | Core executors use the `Clock`/`IdGenerator` ports; **no `Date.now`/`Math.random` in `core/src/workflow/`**; optional lint guard cloned from `backend-kind-literal-guard`. *(§7)* |
| **C6** | Stop/abort | `stop` → run status `stopped` + abort the run `AbortSignal` (composites stop spawning) + `KillWorker(anchorId)` reaps the whole subtree; in-flight joins reject on the resulting `worker:exit`. *(§3.8)* |
| **Concurrency** | Eos has no native cap | An **in-engine counting semaphore** (`ConcurrencyGate`) applied at the single leaf-step choke point, per-run from `config.workflow.maxConcurrentSteps`; a global daemon gate is a composable Open/Closed add-on. *(§3.9)* |
| **Experts** | the standing specialist model | A declarative **`experts[]` field on `WorkflowDefinition`**, spawned `persistent`+`collaborate` under the run anchor by the engine's `run()` skeleton and torn down in a `finally`. NOT a node type. *(§4)* |

### One open decision left (recorded, not invented)

**Cross-level mesh.** The peer mesh is a flat sibling group keyed on `parent_id`. A
step-worker's *own* sub-workers (grandchildren of the anchor) **cannot** consult the
expert pool. If a workflow needs grandchildren to reach experts, that requires new work
(a group/team id decoupled from `parent_id`). Recorded as Open Question O1 (§7); v1
constrains consulting workers to be **direct** children of the anchor.

---

## 2. Current Eos architecture (the relevant slice)

### 2.1 Spawn — two layers, fire-and-forget

The single programmatic "run one agent" function is:

```ts
// core/src/use-cases/SpawnWorker.ts:132 — pure-ish core use-case, ports-injected
export async function spawnWorker(deps, spec): Promise<{ id: string; port: number }>
```

It **resolves at launch, not at turn completion** — there is no awaitable result. Above
it sits the resolution chokepoint:

```ts
// manager/commands/handlers/spawn-worker.ts:17
spawnWorkerHandler.run(_addr, body: SpawnWorkerRequest, { c: Container })
  → SpawnWorkerResponse { id, port, isolation? }   // contracts/src/http.ts:69
```

`spawnWorkerHandler` does `from`→definition resolution (`resolveWorkerDefinitionByName` +
`applyWorkerDefinitionDefaults` + `extends` chain), tool-scope materialization, permission
mode inheritance (`c.modeResolver.resolveFor(parentId)`, only when mode unset —
spawn-worker.ts:88), isolation policy, backend selection + billing guard, and prompt
rendering — *then* calls `spawnWorker`. **The engine must build steps on the handler**, not
the bare use-case, to get all of that for free.

Execution is fully behind the `AgentBackend` port (`core/src/ports/AgentBackend.ts`):
`deps.backend.start(launchSpec, {onExit, onEvent})`. `onExit` is process-lifecycle only —
**it carries no result payload**. Default backend = `claude-sdk` (in-process, runs in the
daemon); fallback = `claude-cli` (PTY). The engine designs against the port, never PTY/SDK
directly.

> **Load-bearing spawn fact** (orchestration peer): a worker spawned **with a `parentId`
> is forced `persistent`** — `SpawnWorker.ts:136`:
> `let resolved = spec.parentId ? { ...spec, persistent: true } : spec;`. So every worker
> the engine spawns under a run anchor **stays alive IDLE after its turn and never exits on
> its own**. `worker:report` is the completion signal; `worker:exit` normally never fires
> for these. **The engine must reap; nothing self-terminates.**

### 2.2 The one hard gap — no synchronous typed-result channel

A worker reports by calling the `send_message_to_parent` MCP tool →
`POST /workers/:id/report` (`manager/routes/workers.ts:577`). The report is a **free-text
string** whose first line is a parsed signal (`result:` / `needs input:` / `failed:`),
classified by `classifyReport()` (`core/src/domain/report-signal.ts:9`). The route then
**dispatches the text as a chat message into the parent agent's next turn**
(`DispatchMessage.ts:152`, `queueWhenBusy:true`).

There is **no `StructuredOutput`-style typed channel** like Claude Code's Workflow tool.
The canonical `AgentEvent` union (`contracts/src/canonical.ts:194`) has a `turn` boundary
and a `session` lifecycle event but **no "final structured result" kind**. The agent's
conclusion lives only in (a) the report text and (b) transcript `text` blocks.

**This is the single most important integration gap.** A deterministic engine wants a
typed object per step. Closing it requires net-new IPC (the `submit_step_output` tool +
route + event — §3.6).

### 2.3 Completion is event-driven; the join must be hand-built

Completion is observed on the `EventBus` (`core/src/ports/EventBus.ts`):

| Signal | Where published | Meaning |
|---|---|---|
| `worker:report` | `manager/routes/workers.ts:583` (synchronous, top of the report route, **before** delivery/hold logic; requires `parent_id`) | the worker called `send_message_to_parent` — **the completion signal** |
| WORKING→IDLE | `TransitionState.ts:46` (state event + `worker:change`) | the turn ended |
| `worker:exit` | `SpawnWorker.ts:226` (backend `onExit`), also `ResumeWorker.ts:71`, `ReconcileWorkersOnBoot.ts:48` | the child **process** died — decoupled from report |

**Ordering guarantees** (state peer, verified):

- `send_message_to_parent` is a **blocking HTTP POST**; the route publishes `worker:report`
  at line 583 *before returning*, so the worker cannot proceed to end/exit until the report
  is already on the bus. ⇒ For any worker that reports, `worker:exit` always arrives
  **after** `worker:report`.
- A persistent worker (all parented workers) reports and **keeps living — no `worker:exit`
  follows**. ⇒ **The join must key on `worker:report`, reject on `worker:exit` only if no
  report for that worker was seen first.** `worker:exit` without a prior report = a genuine
  crash = legitimate failure.
- A **held** report (dynamic-loop report-hold gate, `workers.ts:588`) still fires
  `worker:report` at 583 with `held:true`; the *delivery* is held until the loop goal
  verifies. The step-join must wait for the **released** report (see §3.4 report-hold).

### 2.4 State, parent/child, concurrency

Worker row (`contracts/src/worker.ts`): `state`, `parent_id` (:34), `is_orchestrator`,
`collaborate` (:100), `model`, `effort`, `backend_kind`, `worker_definition`, `tool_scope`,
`worktree_dir`, `branch`, `session_id`, `workspace_owner_id`, and token/cost columns.
States (`contracts/src/events.ts:18`): `SPAWNING | WORKING | IDLE | ENDING | DONE |
KILLING | SUSPENDED`. Children enumerate via `WorkerRepo.listByParent(id)`
(`SqliteWorkerRepo.ts:48` — plain `SELECT * FROM workers WHERE parent_id = ?`).

**Concurrency is NOT managed by Eos.** Every spawn is an independent session; there is no
pool, cap, barrier, or pipeline primitive. The dynamic-loop feature is the closest
existing "keep running until goal met" control, but it is per-worker, not multi-agent. **The
engine owns concurrency entirely** (§3.9).

### 2.5 Definition stores — the precedent to clone

Worker definitions are the existing pattern for "load a flow definition": one Zod shape
(`contracts/src/worker-definition.ts:11`), four origins (`builtin < user < project <
runtime`), a disk port (`WorkerDefinitionSource` → `FileWorkerDefinitionSource` reading
`.eos/workers/*.md` + YAML frontmatter), a per-owner runtime store
(`RuntimeWorkerDefinitionStore` → `SqliteRuntimeWorkerDefinitionStore`, keyed by owner id),
a pure resolver (`core/src/domain/worker-definition-resolution.ts`, last-match-by-name +
`extends`), and a `create_worker` MCP tool (`manager/tools/defs/create_worker.ts` →
`POST /worker-definitions?owner=<selfId>`). **The workflow-definition catalog clones this
trio exactly.**

The runtime **entity** precedent is the dynamic-loop subsystem (`worker_loops`, migrations
047/048): a contract (`contracts/src/loop.ts`), a core port (`LoopStateRepo`), a SQLite
adapter (`SqliteLoopStateRepo`), use-cases (`attachLoop`/`stopLoop`/`runLoopTick`), a route
(`manager/routes/loops.ts`), a bus topic (`loop:change`), config defaults (`config.loop`),
and a boot re-arm (`reArmLoops`, `manager/services/loop-rearm.ts`, called from
`daemon.ts:414`). **`WorkflowRun`/`WorkflowStep` clone this spine.**

### 2.6 The peer mesh (foundation of the expert pool — §4)

`collaborate:true` opts a worker into the mesh: it registers the `list_peers`/`ask_peer`/
`respond_to_peer` tools (`peerDefs`) and injects the collaboration prompt. **Mesh
membership = siblings sharing a parent**, both `collaborate`:

```ts
// core/src/services/Peers.ts:29
arePeers(asker, target) =
  asker.parent_id !== null && asker.parent_id === target.parent_id
  && asker.collaborate && target.collaborate
```

There is **no team/group id — the grouping IS `parent_id`**. `arePeers` never loads the
parent row and never checks the anchor's liveness or its own `collaborate` flag (this is
what makes a synthetic anchor row viable — §3.5). `ask_peer` is a **blocking register-then-poll**
(`POST /workers/:self/peer-request` then poll `GET …/peer-request/:id` every 2500ms); a
`PeerRequestPump` (`daemon.ts:202`) delivers a queued request to an IDLE peer **as a new
turn**, waking it; the peer answers with `respond_to_peer`. A peer may be addressed **by
name before it has spawned** — the request parks as "awaiting" (`registerAwaiting`,
`PendingPeerRequestService.ts:107`, deadline `config.collaborate.awaitTimeoutMs`, default
120s) and binds when a matching collaborate sibling joins (`tryBind`, :214).

---

## 3. Proposed system

### 3.1 Execution model — a daemon-resident interpreter

The engine is a **daemon-resident service** (a sibling of the goal-loop service), **not an
LLM agent**. It calls `spawnWorkerHandler.run()` against the container deps and subscribes
to the `EventBus`. It is *triggered* by an orchestrator agent invoking the single MCP
`workflow` tool (mirroring how Claude Code's model launches a `Workflow` and JS drives the
fan-out) — but the deterministic driving is plain TypeScript in the daemon.

Three roles compose per run:

- **Interpreter** (`WorkflowEngine.runNode`) — recursively evaluates a `WorkflowNode` tree,
  dispatching each node to its registered executor. One evaluator serves both stored and
  dynamic specs; *the tree IS the language*.
- **StepExecutorRegistry** — `type → StepExecutor`. The Open/Closed seam (clone of
  `makeStrategyFor`, `core/src/services/goal-strategy-registry.ts`, and
  `AgentBackendRegistry`, `AgentBackend.ts:179`).
- **`run()` skeleton** (Template Method) — owns the per-run lifecycle: insert run row →
  spawn experts → `runNode(root)` → persist result → `finally` teardown.

### 3.2 The C1 resolution — declarative IR, trusted Builder front-end

**Decision: the dynamic (orchestrator-generated) path is a declarative, Zod-validated
`WorkflowNode` IR. The code DSL is kept only as a trusted, author-time Builder that lowers
to the same IR. There is no public code-execution path in v1.**

**Rationale.** The engine peer led with a code-defined imperative JS DSL (the Claude Code
Workflow model) as primary. The architecture peer objected on a security ground the engine
peer had itself flagged: the orchestrator is an **LLM**, and letting it emit executable JS
means **arbitrary code execution inside the daemon** (which runs in-process claude-sdk
sessions, holds the OAuth credential, and touches the filesystem). When consulted directly,
**the engine peer accepted the reconciliation** and conceded its own headline argument:
"fan-out count derived from prior step output" is **fully covered** by a `forEach` node over
a bound list, and static topology + simple branch/loop are covered by
`sequence`/`parallel`/`pipeline`/`conditional`/`loopUntil`. So the declarative IR covers
control-flow **topology** for the dynamic path.

Both front-ends lower to one IR → one interpreter → one registry. The code Builder
(`core/src/workflow/dsl.ts`) is a trusted typed surface for **built-in / author-time**
workflows that ship as code; it constructs `WorkflowNode` data and does not execute
anything.

```
   code Builder (trusted, author-time) ─┐
                                         ├─→  WorkflowNode IR  ─→  WorkflowEngine.runNode  ─→  StepExecutorRegistry
   declarative spec (orchestrator/LLM) ─┘       (Zod-validated)        (Interpreter)            (one executor per type)
```

#### What this honestly costs (do not paper over it)

The engine peer was blunt: the declarative IR is **capped below code power** because it has
no inline *glue* — the deterministic non-agent computation Claude Code does in plain JS
between `agent()` calls (filter / map / flatten / dedup-against-a-set / tally-votes /
cross-iteration counters). Two concrete flows the declarative IR **genuinely cannot**
represent today:

1. **loop-until-dry with cross-round dedup** — needs a set-difference (`fresh = thisRound −
   allSeen`), a "2 consecutive empty rounds" counter, and a `key()` extraction. None is a
   worker spawn; all are deterministic glue. A `loopUntil` with an `eq/exists/and/or`
   predicate cannot compute a set-difference.
2. **judge-panel majority vote** ("keep finding if ≥2 of 3 verifiers say real") — needs to
   *tally* a list; a tiny predicate cannot count across a list.

**Honest scope statement for v1** — *the dynamic/orchestrator-generated path supports static
topology + data-driven fan-out + simple branch/loop. The adaptive quality-harnesses
(loop-until-dry, judge-panel, adversarial-verify) are **built-in-only** via the trusted code
Builder until the dynamic path gets a glue story.* Do **not** let the resolution imply
"dynamic path == code power."

**Recommended mitigation (planned for v1.x, design the seam in v1):**
- Add a **small set of reified transform/aggregator node types** — `map` / `filter` /
  `dedup` / `tally` / `accumulate` — each a registered `StepExecutor` (Open/Closed via the
  same registry). Prefer this over a general expression language (which the architecture
  peer rightly wants to avoid).
- **Expose loop iteration metadata into predicate bindings** (`ctx.iteration`,
  `ctx.lastResult`, `ctx.lastCount`) so `loopUntil` can express "stop after N" and "stop
  when last round produced 0" without code. Without this, `loopUntil` is nearly inert for
  adaptive use — build it in v1.

#### One correctness note carried from the engine peer — the `pipeline` executor

A naive tree-interpreter implements `pipeline` as `for stage in stages: parallel(items.map(stage))`.
**That is wrong** — it silently degrades `pipeline` into "sequence-of-parallel-stages" with
a barrier between every stage, destroying the entire point (item A in stage 3 while item B
is still in stage 1; wall-clock = slowest single item-chain). **The `PipelineExecutor` must
launch N independent per-item chains concurrently**, each item flowing through all its
stages on its own. Flagged explicitly so the engine "has a pipeline" that actually is one.

### 3.3 The DSL primitive set & node semantics

The IR is a `WorkflowNode` discriminated union (Command + Composite). Each member maps to
one executor (Strategy).

| Node `type` | Semantics | Barrier? | Maps to Eos |
|---|---|---|---|
| `step` | **Leaf.** Spawn ONE worker from a definition + prompt; await its terminal report; if `outputSchema` set, return the **Zod-validated object**, else the report text. The only node that touches Eos. | n/a | `spawnWorkerHandler.run` + `PendingJoin` over `worker:report`/`worker:exit` + Zod validate-with-retry |
| `sequence` | children in order; bindings accumulate | implicit | recurse `ctx.engine.runNode` |
| `parallel` | children concurrently; **await all** | **yes** | N spawns + `Promise.all` of joins; use only when stage N needs ALL of N−1 (synthesis/dedup/early-exit-on-zero) |
| `pipeline` | each item flows through all stages independently | **no** (default for multi-stage) | N independent per-item chains, scheduled concurrently (see §3.2 note) |
| `forEach` | data-driven fan-out over a bound list (count known only at runtime) | configurable | the reason `forEach` is reified, not host JS — the declarative path has no loops |
| `conditional` | run `then`/`else` by a Specification predicate over run bindings | n/a | pure `predicate.evaluate(pred, bindings)` |
| `loopUntil` | re-run child until predicate/limit (analog of `dynamic_loop`) | n/a | iteration metadata in bindings (§3.2) |
| `phase` | observability grouping (label) wrapping children | n/a | emit a `workflow:step-change` progress event |
| `subWorkflow` | resolve a stored workflow by name, run its root | n/a | registry lookup + `engine.runNode` (no Mediator) |

**Data flow is explicit named bindings, never a shared blackboard.** Each node carries a
stable `id`; its output lands in a run-scoped `BindingScope` map; downstream prompts
reference `{{nodes.<id>.output}}` (and `{{args.*}}`), resolved by the engine *before* the
executor runs. Step I/O is Zod-typed both directions.

**Determinism (C5):** executors use the `Clock`/`IdGenerator` ports; `Date.now`/`Math.random`
are banned in `core/src/workflow/`. Any intentional randomness is seeded and journaled.

### 3.4 The per-step algorithm (the leaf `step` executor)

```
step({ from, prompt, model?, effort?, toolsAllow?, toolsDeny?, outputSchema? }):
  0. memo-check: if workflow_steps has this (runId,nodeId) status=passed → return journaled output  (resume)
  1. jsonSchema   = outputSchema ? zodToJsonSchema(outputSchema) : null
  2. fullPrompt   = resolveBindings(prompt) (+ "return JSON via submit_step_output matching <schema>" if jsonSchema)
  3. {id}         = await spawnWorkerHandler.run(NoAddr,
                      { from, prompt: fullPrompt, model, effort, toolsAllow, toolsDeny,
                        parentId: run.anchorId, claudePermissionMode: run.mode,  // explicit — sidesteps inheritance
                        collaborate: true, withGateway: true, worktreeFrom/cwd }, { c })
  4. outcome      = await concurrencyGate.run(() => pendingJoin.await(id, signal))
                      // resolves on worker:report (RELEASED, not held) carrying step-output JSON if submit_step_output used;
                      // rejects on worker:exit with no prior report (crash);
                      // ignores the run anchor's own spurious worker:exit (filter by id)
  5. PERSIST step status+output the instant the report is observed   // MANDATORY — crash-correctness (§3.7)
  6. if outputSchema:
        try   return outputSchema.parse(outcome.output)
        catch (ZodError) → re-prompt worker (bounded N retries), goto 4 ; else mark failed
     else return outcome.reportText      // status-prefixed text via classifyReport()
```

`pendingJoin` = `Map<workerId, {resolve, reject}>`, wired once to
`bus.subscribe("worker:report", …)` and `bus.subscribe("worker:exit", …)`. This is the
single new in-memory primitive; everything else reuses existing seams.

**Report-hold interaction (v1 wiring constraint).** A held report still fires `worker:report`
with `held:true`; the real completion is the post-goal-check *release*. The join must wait
for the released report. **Step-workers must NOT arm their own dynamic loops** — *the
workflow IS the control loop*. Use `loopUntil` at the workflow level instead. (Both the
engine and architecture peers agree.)

### 3.5 Spawn integration — `WorkerSpawnPort`, the run anchor, the join

The leaf executor depends on a narrow core port; the manager adapter does the real work:

```ts
// core/src/ports/WorkerSpawnPort.ts
export interface WorkerSpawnPort {
  spawnAndAwait(spec: SpawnStepSpec, signal: AbortSignal): Promise<StepOutcome>;
  spawnExpert(spec: ExpertSpawnSpec): Promise<{ workerId: string }>;  // persistent + collaborate
  killWorker(workerId: string): void;                                  // teardown / abort
  mintRunAnchor(runId: string, ownerId: string, mode: string): string; // synthetic anchor row
}
```

The manager adapter (`WorkerSpawnAdapter`) implements `spawnAndAwait` as:
`spawnWorkerHandler.run(...)` → register a `PendingJoin` entry → resolve on matching
`worker:report` / reject on matching `worker:exit`. Using the *handler* (not raw
`spawnWorker`) gives `from`-definition/tool-scope/mode/backend resolution for free.

**Run anchor identity (C4) — resolved by the orchestration peer.** Each run gets a
**synthetic anchor worker-row**, not a live Claude process and not the orchestrator's own id:

- **Why synthetic, not the orchestrator id:** the mesh must be scoped to exactly *{this
  run's experts + step-workers}*. If the anchor were the orchestrator, the mesh would leak
  to every other collaborate child the orchestrator spawned, and teardown could not "kill
  the anchor subtree" cleanly.
- **Why a row, not a live worker:** `arePeers` and `listByParent` operate purely off the
  `parent_id` **column value** and never load or execute the anchor row. A live anchor buys
  nothing and burns a subscription session.
- **How to mint it cleanly:** `WorkerRepo.insert` a row with `id = runId`, `prompt =
  "[workflow-run anchor]"`, `parentId = orchestrator selfId` (preserves ownership + the
  inheritance chain), `is_orchestrator: 1`, null `pid`/`port`/`session_id`, no worktree.
  Nothing downstream chokes: `WorkerRowSchema` makes those nullable; `supervisor.has` →
  false; git/diff routes gate on `workspace_ready`.
- **Mode:** set `claudePermissionMode` **explicitly** on every expert/step spawn (the engine
  knows the run mode) — this sidesteps `modeResolver.resolveFor(parentId)` entirely and
  removes any dependence on the anchor row for mode.
- **The one caveat — boot reconcile:** a synthetic anchor with no `session_id` is
  `resumable=false`, so `ReconcileWorkersOnBoot` (`:33`) marks it `DONE` + emits a spurious
  `worker:exit`. Harmless: a `DONE` anchor still satisfies `findById` (so
  `killWorker(anchorId)` works) and still matches `parent_id = ?` (so mesh + reap keep
  working — those ignore anchor state). Mitigations: (a) the engine self-heals its run
  table on its own boot (re-insert anchor rows for in-flight runs); (b) the join filters
  the anchor's own `worker:exit` by id so it is never mistaken for a step terminal.

**Teardown.** `killWorker(anchorId)` is recursive depth-first over children
(`KillWorker.ts:49`, `findChildrenIds` = `SELECT id FROM workers WHERE parent_id = ?`,
`SqliteWorkerRepo.ts:80`) → kills experts + step-workers + any stragglers in one call. The
core `killWorker` has no ownership check (a daemon-resident engine is trusted); the
ownership gate lives in the command/route layer for agent-triggered kills.

### 3.6 Typed step I/O — `submit_step_output` (the one net-new IPC path)

Because Eos has **no typed-result channel** (§2.2), typed step output is genuinely new work
and on the critical path (it is what feeds "3 research outputs → 5 analysis workers").

**Decision: build it.** New plumbing, cloning `send_message_to_parent`'s shape:

1. **Worker-visibility MCP tool** `submit_step_output(json)` (`manager/tools/defs/submit_step_output.ts`,
   added to `workerDefs` in `tools/registry.ts`). Description in the prompt library.
2. **Route** `POST /workers/:id/step-output` (`manager/routes/workflow-step-output.ts`):
   validate against `StepResultRequestSchema` (contracts), `bus.publish("worker:report", …)`
   (or a dedicated `workflow:step-result` topic carrying the JSON) → resolves that step's
   `PendingJoin` with the validated object, and **persists `workflow_steps.output` durably
   in the same handler** (so the completion survives a crash — §3.7).
3. **Engine side:** lower `outputSchema` to JSON Schema (`zod-to-json-schema`), inject the
   instruction into the prompt, `schema.parse()` the returned JSON, and re-prompt the worker
   on `ZodError` (bounded retries) — exactly Claude Code's `opts.schema` behavior.

**v1 fallback** (strictly additive degrade): a step that declares **no `outputSchema`** uses
the existing report-text path — the join reads the report, `classifyReport()` yields
`result|needs-input|failed|unknown`, and downstream prompts embed the raw text. So even
before `submit_step_output` lands, flows run; typed bindings light up where a schema is
declared.

> **Zod cross-package caution** (project memory `zod-cross-package-record-instanceof-trap`):
> define each step schema **once** in `contracts/` and import it. Do **not** re-wrap a
> contracts schema in a manager-side `z.record(key,val)` — separate Zod copies break
> `instanceof`. Use 1-arg `z.record(Schema)`.

### 3.7 Persistence, streaming, resume

**Persistence mirrors `worker_loops` exactly** (state peer). Entity tables for *current
state*; the `events` table for *replayable timeline*; bus topics for *live refetch nudges*.

Tables (appended forward-only to `infra/src/persistence/MigrationRunner.ts`):

```sql
-- workflow_definitions — owner+name UPSERT, clone of worker_definitions (mig 050)
CREATE TABLE IF NOT EXISTS workflow_definitions (
  owner TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner, name));

-- workflow_runs — clone of worker_loops status-lifecycle entity
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, definition_name TEXT, owner TEXT NOT NULL, anchor_id TEXT NOT NULL,
  status TEXT NOT NULL, args_json TEXT, result_json TEXT,
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

-- workflow_steps — the step rows ARE the resume cursor + memoization journal
CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, node_type TEXT NOT NULL,
  status TEXT NOT NULL, worker_id TEXT, output_json TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps(run_id);
```

SQLite adapters clone `SqliteLoopStateRepo` / `SqliteRuntimeWorkerDefinitionStore`:
prepared statements cached in the ctor, `*_json` via `safeStringify`, read via `JSON.parse`
+ `Schema.safeParse` skip-on-invalid, `Date.now()` for audit timestamps at the adapter edge.

**Streaming is free.** Add `"workflow:run-change" | "workflow:step-change"` to the
`EventBusTopic` union (`core/src/ports/EventBus.ts:5`); a `ProgressSink` core port
(Observer) keeps the engine ignorant of the bus, and its manager adapter
(`EventBusProgressSink`) calls `c.bus.publish(...)`. `SseBroadcaster` already relays every
topic via `subscribe("*")` → clients in ~100ms (the `loop:change` model). For a replayable
per-run timeline, append run/step transitions to the existing `events` table via `LogEvent`
keyed by `runId` (add types to `WorkerEventTypeSchema`). *Caveat:* the `events` table is
`worker_id`-keyed and prunes newest-N, so a very long run could lose early step rows; lean
**reuse-`events` for v1**, clone into a dedicated `workflow_events` table only if a full
audit trail must outlive pruning.

**Resume — revised to mandatory v1** (state + engine peers). `worker:report` is an
**ephemeral** `InMemoryEventBus` topic, lost on restart, and **not persisted on the worker's
own row**. The durable trace is the parent-timeline `worker_report` event
(`DispatchMessage.ts:76`, `workerId = parent_id`, `payload.fromWorker = stepWorkerId`),
written **after** the publish, only on delivery. A crash in that window drops the
completion — and **a reconciled/resumed worker that already reported will NOT re-report**,
so an unpersisted step-completion is lost forever and the run wedges. Therefore:

- **MANDATORY v1:** persist `workflow_steps.status` + `output_json` the instant
  `worker:report` (released) is observed — your own durable journal, written in the
  step-output route handler. `WorkflowRunRepo`/`WorkflowStepRepo` expose `listActive()`.
- **Expected v1:** a `reArmWorkflows()` boot hook (sibling of `reArmLoops`,
  `manager/services/loop-rearm.ts`, wired in `daemon.ts` alongside the `:414` call). On
  boot, for each step still `running`, reconcile from **three durable sources**: (1) the
  child worker state (`ReconcileWorkersOnBoot` → SUSPENDED if resumable, else DONE +
  `worker:exit{reason:'boot_reconcile'}`); (2) a parent-timeline `worker_report` event with
  `payload.fromWorker === stepWorkerId`; (3) an agent-plane `queued_messages` row for that
  envelope (`queued_messages` is durable + idempotent `UNIQUE(worker_id, client_msg_id)`;
  the report route passes `queueWhenBusy:true`, `workers.ts:642`). `events.id` is a single
  global `AUTOINCREMENT`, so it orders a report row vs an exit row across different worker
  timelines. → step done (recover output) / failed (exit-only) / resume the worker
  (SUSPENDED + no report evidence).
- **v1.x fast-follow (the only deferrable piece):** *auto-continuing* a half-finished run —
  re-walking the tree past done steps and spawning the next nodes. Even this is v1-attainable
  given `reArmLoops` as the template; surface runs as resumable in v1, auto-continue in v1.x.

The declarative IR makes this *easier*, not harder: each step is an entity row exactly like
`worker_loops`, so resume is **entity-row reconciliation** (the established Eos idiom), not
script replay.

**Experts are never journaled** (they are config, not results) — so on resume they re-spawn
fresh (§4), which is correct because their processes died with the daemon.

### 3.8 Stop / abort (C6)

`workflow` tool `mode:"stop"` (a) sets run status `stopped` via `WorkflowRunRepo.setStatus`,
(b) aborts the run's `AbortSignal` so in-flight composites stop spawning new children, and
(c) `killWorker(anchorId)` reaps the entire subtree (experts + step-workers). The join's
`worker:exit` subscription then rejects in-flight `spawnAndAwait` calls cleanly; the engine
filters the anchor's own exit. No conflict — pure wiring.

### 3.9 The ConcurrencyGate (Eos has no native cap)

A **pure in-engine counting semaphore** — Eos provides none, so the engine owns it:

```ts
// core/src/ports/ConcurrencyGate.ts — run<T> wrapper so release is exception-safe
export interface ConcurrencyGate { run<T>(fn: () => Promise<T>): Promise<T>; }
// core/src/workflow/concurrency.ts — pure impl (promises + queue, zero Node)
```

- **Single choke point at the leaf step executor**, not in each composite:
  `await ctx.concurrency.run(() => ctx.spawn.spawnAndAwait(spec, ctx.signal))`. This caps any
  fan-out source uniformly (`parallel`/`forEach`/`pipeline`/nested) with no double-counting;
  composites stay dumb about the cap (DRY + SRP).
- **One instance per run**, created in `run()` from `config.workflow.maxConcurrentSteps`
  (manager resolves config; core never reads it — the `config.loop`→`attachLoop` pattern),
  injected via `WorkflowExecCtx`, shared by every child ctx → a true per-run cap.
- **Cross-run (blunt):** a per-run gate does **not** protect the machine when multiple runs
  run concurrently (N runs × cap = N×cap live workers; Eos has no global cap). Ship per-run
  in v1; a daemon-global semaphore composes *under* the per-run gate at the same choke point
  (the leaf acquires both) — Open/Closed, no interface change. Build it if concurrent runs
  are expected.

### 3.10 The single MCP `workflow` tool surface

One orchestrator-visibility tool, discriminated-union input (mirrors `spawn_worker`'s
`from`), posting through the unified command catalog:

```ts
// contracts/src/workflow.ts
export const WorkflowToolRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("run-stored"), from: z.string(), args: z.unknown().optional() }),
  z.object({ mode: z.literal("run-inline"), spec: WorkflowDefinitionSchema, args: z.unknown().optional() }),
  z.object({ mode: z.literal("create"),     spec: WorkflowDefinitionSchema }),
  z.object({ mode: z.literal("status"),     runId: z.string() }),
  z.object({ mode: z.literal("stop"),       runId: z.string() }),
]);
```

`manager/tools/defs/workflow.ts` posts `runWorkflowCommand` / `createWorkflowCommand`
(handlers cloned from `spawn-worker.ts`) with `ownerId = ctx.selfId`. A sibling
`create_workflow` persists a dynamic spec for reuse (mirrors `create_worker`). Definition
resolution overlays sources by precedence (`builtin` code-DSL modules → `user`/`project`
files `~/.eos/workflows/*` → `runtime` `SqliteRuntimeWorkflowDefinitionStore`), nearest-wins,
unknown name = hard error (mirrors the worker-definition resolver).

### 3.11 Design-pattern map

| Pattern | Lives in | Responsibility | Eos precedent |
|---|---|---|---|
| **Ports & Adapters** | core ports + infra/manager adapters | pure domain in core, all I/O behind ports (lint-enforced) | `AgentBackend.ts` |
| **Strategy** | `StepExecutor` + impls | one algorithm per node `type`; the Open/Closed unit | `GoalCheckStrategy` (command/judge/hybrid) |
| **Command** | `WorkflowNode` union (contracts) | a node = serializable, self-describing, executable data (no `execute()` on the data) | `CommandDef` catalog |
| **Composite** | container nodes hold `children` | uniform leaf/container nesting | — (new) |
| **Interpreter** | `WorkflowEngine.runNode` | recursively evaluate the tree, dispatch to executors | `template-engine.ts` |
| **Registry + Factory** | `StepExecutorRegistry` + `WorkflowDefinitionRegistry` | `type→executor`, `name→definition`; THE Open/Closed seam | `makeStrategyFor`, `AgentBackendRegistry`, `WorkerDefinitionSource` |
| **Builder / fluent DSL** | `core/src/workflow/dsl.ts` | trusted author-time IR construction; lowers to the same IR | — (new); echoes Claude Code Workflow |
| **Observer** | `ProgressSink` + `EventBusProgressSink` | run/step lifecycle → EventBus → SSE | `EventBus` + `SseBroadcaster`, `loop:change` |
| **Memento / Event-sourcing** | `WorkflowStepRepo` (journal) + SQLite | per-node result journal; memoized replay | `events` + `SqliteEventRepo`, `reArmLoops` |
| **Specification** | `core/src/workflow/predicate.ts` | evaluate `conditional`/`loopUntil` gates | `fragment-select.ts` `when`, `condition-eval.ts` |
| **Template Method** | `runNode` fixed skeleton (resolve bindings → memo-check → execute → journal → publish) | cross-cutting concerns out of every executor (SRP) | `runLoopTick` fixed precedence |

**Rejected for v1 (anti-over-engineering):** generator/coroutine runtime + code sandbox for
the dynamic path (declarative IR suffices, security); Temporal strict command-compare
determinism (prefix/entity memoization is enough); Visitor over the node tree (only one
tree operation — interpret — exists; add when ≥2 walks appear); Mediator / dedicated
sub-workflow orchestrator (`subWorkflow` is just another executor); Chain-of-Responsibility
for phases (a phase is ordered composition, not "first handler that can"); normalized step
child-tables (JSON columns per house style). **Saga/compensation** (undo worktree-mutating
steps) is a future registered executor + `compensate` hook — designing the journal now keeps
the door open; building it now is speculative.

### 3.12 Clean-arch layering & full module/folder layout

Dependency direction is lint-enforced (`contracts → core → infra → manager → entrypoints`).
Pure node-tree + engine + executors + ports live in `core/` (zero Node). SQLite/file
adapters in `infra/`. Driver service + spawn-join glue + routes + MCP tools + boot re-arm
in `manager/`. Every IPC/stored shape is a Zod schema in `contracts/`.

```
contracts/src/
  workflow-node.ts     # WorkflowNode discriminated union + per-node schemas (Command/Composite IR)
  workflow.ts          # WorkflowDefinition (+experts[]), WorkflowRun, status enums,
                       #   WorkflowToolRequest, StepResultRequestSchema, records
  commands/defs.ts     # +workflow.run / workflow.create CommandDef entries (append)
  events.ts            # +workflow_run_started/_done/_failed, workflow_step_* persisted types (append)
  http.ts              # +ROUTES: workflows, workflowRun(id), workflow-step-output(id) (append)

core/src/ports/
  StepExecutor.ts  StepExecutorRegistry.ts  WorkflowEngine.ts
  WorkerSpawnPort.ts  ProgressSink.ts  ConcurrencyGate.ts
  WorkflowRunRepo.ts  WorkflowStepRepo.ts
  RuntimeWorkflowDefinitionStore.ts  WorkflowDefinitionSource.ts
core/src/workflow/            # NEW pure sub-package (Interpreter + executors + DSL)
  engine.ts            # runNode skeleton (Template Method) + memoized replay
  registry.ts          # InMemoryStepExecutorRegistry
  bindings.ts          # BindingScope: id->output, {{nodes.<id>.output}} resolution
  predicate.ts         # Specification evaluator for conditional/loopUntil gates
  concurrency.ts       # pure counting semaphore (ConcurrencyGate impl)
  dsl.ts               # fluent Builder → WorkflowNode IR (trusted, author-time)
  executors/
    step.ts sequence.ts parallel.ts pipeline.ts forEach.ts
    conditional.ts loopUntil.ts phase.ts subWorkflow.ts
    # v1.x: map.ts filter.ts dedup.ts tally.ts accumulate.ts (glue nodes — §3.2)
core/src/use-cases/
  RunWorkflow.ts  ResumeWorkflow.ts  StopWorkflow.ts  CreateWorkflowDefinition.ts

infra/src/persistence/
  MigrationRunner.ts   # append: workflow_definitions, workflow_runs, workflow_steps
  SqliteWorkflowRunRepo.ts  SqliteWorkflowStepRepo.ts  SqliteRuntimeWorkflowDefinitionStore.ts
infra/src/workflow/
  FileWorkflowDefinitionSource.ts

manager/
  services/
    WorkflowService.ts       # daemon-resident driver (sibling of the goal-loop service)
    workflow-rearm.ts        # reArmWorkflows() boot hook (sibling of loop-rearm.ts)
    WorkerSpawnAdapter.ts     # WorkerSpawnPort impl: spawnWorkerHandler.run() + PendingJoin + anchor mint
    EventBusProgressSink.ts   # ProgressSink impl
  commands/handlers/
    run-workflow.ts  create-workflow.ts   # CommandHandler<...> (clone spawn-worker.ts)
  routes/
    workflows.ts             # GET/POST /workflows, /workflow-runs, status/stop
    workflow-step-output.ts  # POST /workers/:id/step-output → resolves the step's PendingJoin + persists
  tools/defs/
    workflow.ts              # the SINGLE MCP workflow tool (orchestrator visibility)
    submit_step_output.ts    # worker-visibility: typed step result back to the engine
  tools/registry.ts          # +workflowDef to orchestratorDefs; +submit_step_output to workerDefs
  container.ts               # composition root: build registry, register executors, wire repos+gate
  daemon.ts                  # reArmWorkflows() alongside reArmLoops(); register routes; subscribe join

core/src/ports/EventBus.ts   # +"workflow:run-change" | "workflow:step-change" (append to union)
manager/shared/config.ts     # +config.workflow block + mergeConfig branch
manager/shared/user-data.ts  # +"workflows" entry (file defs dir, non-regenerable)
```

### 3.13 Core port interfaces (TS)

```ts
// --- StepExecutor.ts — the Strategy; ONE per node type ---------------------
export interface NodeResult {
  readonly output: unknown;            // validated step output / aggregate of children
  readonly status: "passed" | "failed" | "skipped";
  readonly childWorkerIds?: string[];  // ownership/cleanup + UI
}
export interface StepExecutor<N extends WorkflowNode = WorkflowNode> {
  readonly type: N["type"];            // registry key
  execute(node: N, ctx: WorkflowExecCtx): Promise<NodeResult>;
}
export interface NodeRunner { runNode(node: WorkflowNode, ctx: WorkflowExecCtx): Promise<NodeResult>; }

export interface WorkflowExecCtx {
  readonly runId: string;
  readonly anchorId: string;            // synthetic run anchor (parentId for every spawn) — §3.5
  readonly mode: string;                // run permission mode, set explicitly on every spawn
  readonly args: unknown;
  readonly bindings: BindingScope;      // id -> output; resolves {{nodes.<id>.output}}
  readonly engine: NodeRunner;          // recursion seam (DIP — executors never import the impl)
  readonly spawn: WorkerSpawnPort;
  readonly progress: ProgressSink;
  readonly clock: Clock;                // existing port — determinism (C5)
  readonly ids: IdGenerator;            // existing port
  readonly log: Logger;
  readonly concurrency: ConcurrencyGate;// in-engine semaphore (§3.9)
  readonly signal: AbortSignal;         // stop/kill propagation (C6)
  // loop metadata (§3.2) injected for loopUntil children:
  readonly iteration?: number;
  readonly lastResult?: unknown;
  readonly lastCount?: number;
}

// --- StepExecutorRegistry.ts — Registry/Factory (clone makeStrategyFor) -----
export interface StepExecutorRegistry {
  register(exec: StepExecutor): void;   // composition-root only — explicit, not reflection
  get(type: string): StepExecutor;      // throws on unknown type (clear error)
  has(type: string): boolean;
  types(): string[];
}

// --- WorkerSpawnPort.ts — narrow seam the leaf step uses (manager adapter) --
export interface SpawnStepSpec {
  readonly runId: string; readonly parentId: string;   // = anchorId
  readonly from?: string; readonly prompt: string;
  readonly model?: string; readonly effort?: string;
  readonly toolsAllow?: string[]; readonly toolsDeny?: string[];
  readonly mode: string;                                // explicit — sidesteps inheritance
  readonly collaborate: boolean;                        // true so steps can consult experts
  readonly outputSchema?: unknown;                       // when set, await submit_step_output
}
export interface StepOutcome {
  readonly workerId: string;
  readonly signal: "result" | "needs-input" | "failed" | "unknown"; // classifyReport()
  readonly reportText: string;
  readonly output?: unknown;             // present iff submit_step_output was used
}
export interface WorkerSpawnPort {
  spawnAndAwait(spec: SpawnStepSpec, signal: AbortSignal): Promise<StepOutcome>;
  spawnExpert(spec: ExpertSpawnSpec): Promise<{ workerId: string }>;
  killWorker(workerId: string): void;
  mintRunAnchor(runId: string, ownerId: string, mode: string): string;
}

// --- ProgressSink.ts — Observer seam --------------------------------------
export interface ProgressSink {
  runChanged(runId: string, status: WorkflowRunStatus): void;
  stepChanged(runId: string, nodeId: string, status: StepStatus, workerId?: string): void;
}

// --- ConcurrencyGate.ts (§3.9) --------------------------------------------
export interface ConcurrencyGate { run<T>(fn: () => Promise<T>): Promise<T>; }

// --- WorkflowEngine.ts — Interpreter entrypoint ---------------------------
export interface WorkflowEngine extends NodeRunner {
  run(def: WorkflowDefinition, args: unknown, ctx: RunContext): Promise<WorkflowRunResult>;
  resume(runId: string, ctx: RunContext): Promise<WorkflowRunResult>;
}

// --- persistence ports (clone LoopStateRepo / RuntimeWorkerDefinitionStore) -
export interface WorkflowRunRepo {
  insert(row: WorkflowRunRow): void;
  findById(id: string): WorkflowRunRow | null;
  listActive(): WorkflowRunRow[];       // status IN (pending, running) — boot re-arm
  listByOwner(ownerId: string): WorkflowRunRow[];
  setStatus(id: string, status: WorkflowRunStatus): void;
  setResult(id: string, result: unknown): void;
}
export interface WorkflowStepRepo {     // also the resume cursor + journal index
  upsert(row: WorkflowStepRow): void;
  listByRun(runId: string): WorkflowStepRow[];
  findByNode(runId: string, nodeId: string): WorkflowStepRow | null; // memoized replay
  setStatus(runId: string, nodeId: string, status: StepStatus): void;
  setOutput(runId: string, nodeId: string, output: unknown): void;
}
export interface RuntimeWorkflowDefinitionStore {
  create(ownerId: string, def: WorkflowDefinition): void;
  listFor(ownerId: string): WorkflowDefinitionRecord[];
  deleteForOwner(ownerId: string): void;
}
export interface WorkflowDefinitionSource { list(): WorkflowDefinitionRecord[]; }
```

---

## 4. The standing specialist / expert-worker model

This is a **load-bearing part of the user's vision**, not a footnote: experts — a SOLID
expert, a design-patterns expert, a domain expert — are spawned **once at run start** and
kept **IDLE-but-consultable** in the background, so step-workers consult them **on demand**
via the peer mesh *while they work*, and the engine tears them down at run end.

### 4.1 Why it maps cleanly onto Eos

Everything needed already exists (orchestration peer, verified):

- **Persistent + consultable:** a parented worker is **forced persistent** (`SpawnWorker.ts:136`)
  — it stays alive IDLE after answering and never exits on its own. `isConsultable(w)` is
  true for IDLE (`Peers.ts`). So a spawned expert *is* a standing, ready provider with no
  extra mechanism.
- **The mesh = collaborate siblings under one parent** (`arePeers`, `Peers.ts:29`). Spawn
  experts **and** step-workers with `collaborate:true` under the **same anchor `parentId`**
  → they are siblings → step-workers can `list_peers` / `ask_peer` the experts **by name**.
- **Order-independent discovery:** `ask_peer` by **name** parks as "awaiting" and binds when
  the named expert joins (`registerAwaiting` + `tryBind`, `PendingPeerRequestService.ts:107/214`).
  So a step-worker that starts before an expert finishes booting **still reaches it** — the
  consult blocks until the provider joins (bounded by `config.collaborate.awaitTimeoutMs`,
  default 120s).
- **Waking a standing expert:** the `PeerRequestPump` (`daemon.ts:202`) delivers a queued
  request to an IDLE expert **as a new turn**, lifting it WORKING; it answers with
  `respond_to_peer` and returns to IDLE. Answering is a normal turn. At most one delivered
  request per expert at a time; extras queue and deliver at its next IDLE.
- **Teardown:** `killWorker(anchorId)` recursively reaps experts + step-workers in one call
  (`KillWorker.ts:49`).

### 4.2 The crux + one hard constraint

**The crux works:** later-spawned step-workers reach earlier-spawned experts under the same
anchor, because `arePeers` only requires a shared `parent_id` + both `collaborate`, with
order-independent `tryBind`.

**Hard constraint (Open Question O1):** the mesh is a **flat sibling group under ONE
parent**. A step-worker's *own* sub-workers (grandchildren of the anchor) **cannot** reach
the expert pool — they are a different sibling group. So in v1, **consulting workers must be
direct children of the anchor**. Cross-level access needs new work (a group/team id
decoupled from `parent_id`, replacing the `parent == parent` check in `Peers.ts`). Recorded,
not invented.

### 4.3 Design: declarative data, engine-skeleton lifecycle

**Decision (architecture peer, decisive): experts are a declarative `experts[]` field on
`WorkflowDefinition`, managed by the engine's `run()` Template-Method skeleton — NOT a node
type.** Experts are ambient run-scoped *infrastructure*: they produce no output that feeds
downstream; they are consulted out-of-band. Modeling them as nodes has three real costs:

1. **Open/Closed cost (the dealbreaker):** a `SpawnExpertsNode` + teardown node forces the
   interpreter to special-case `node.type` ("teardown always runs even on failure",
   "expert-spawn must not be memoized"). The whole foundation is "`runNode` never branches on
   `node.type`." Option (b) adds **zero** node types and **zero** interpreter changes.
2. **Teardown guarantee:** a teardown *node* only fires if control reaches it — a failed/
   aborted step skips it → **experts leak**. A `finally` in `run()` is structurally
   guaranteed (success, failure, abort).
3. **Resume correctness:** a journaled "spawn-experts" node would be memoized as done on
   resume and the experts **not** respawned — but those processes died with the daemon.
   Keeping experts **out** of the journal (config, not results) makes fresh re-spawn on
   resume fall out for free.

### 4.4 Schema + engine wiring

```ts
// contracts/src/workflow.ts
export const ExpertSpecSchema = z.object({
  id: z.string(),                 // stable handle → becomes the peer-name slug
  from: z.string().optional(),    // worker-def: "solid-expert" | "patterns-expert" | "domain-expert"
  prompt: z.string(),             // standing directive: its domain + "stay IDLE-but-consultable"
  model: z.string().optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
});
export const WorkflowDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  argsSchema: z.unknown().optional(),
  experts: z.array(ExpertSpecSchema).default([]),   // ← the standing pool
  root: WorkflowNodeSchema,
});
```

```ts
// core/src/workflow/engine.ts — run() Template Method; resume() runs the SAME try/finally
async run(def, args, ctx) {
  const anchorId = ctx.spawn.mintRunAnchor(ctx.runId, ctx.ownerId, ctx.mode); // synthetic row (§3.5)
  runs.insert({ id: ctx.runId, anchorId, status: "running", ... });
  progress.runChanged(ctx.runId, "running");
  const expertIds: string[] = [];
  try {
    for (const e of def.experts) {                            // SETUP — once, before any step
      const { workerId } = await ctx.spawn.spawnExpert({
        parentId: anchorId, name: e.id, from: e.from, prompt: e.prompt,
        model: e.model, effort: e.effort, mode: ctx.mode,
        persistent: true, collaborate: true,                  // persistent + collaborate = standing mesh provider
      });
      expertIds.push(workerId);
    }
    const r = await this.runNode(def.root, makeCtx(ctx, anchorId)); // every step spawns under anchorId, collaborate:true
    runs.setStatus(ctx.runId, r.status === "passed" ? "passed" : "failed");
    runs.setResult(ctx.runId, r.output);
    return { runId: ctx.runId, status: r.status, output: r.output };
  } finally {
    ctx.spawn.killWorker(anchorId);   // TEARDOWN — guaranteed; reaps experts + steps in one recursive call
  }
}
```

**Mesh wiring (the load-bearing detail):** experts and step-workers must be **siblings under
the one shared anchor** with `collaborate:true`. The expert's `id` is its peer-name slug, so
step-workers consult by name (`ask_peer peerName:"solid-expert"`) and the "block until a peer
with that name joins" semantics mean a step-worker that starts before the experts finish
booting still reaches them. Experts are never journaled; on `resume()` they re-spawn fresh
before the replay-walk.

> Lifecycle notes for the build: standing experts auto-persist (good) but also **auto-linger**
> — explicit `killWorker` is required, there is no idle GC. Long-running flows may need
> `config.collaborate.awaitTimeoutMs` raised so a step's consult doesn't time out waiting for
> a busy expert.

### 4.5 Worked example — a build workflow whose implementers consult experts

Author-time, via the trusted code Builder (lowers to the same IR the dynamic path uses):

```ts
import { wf } from "../workflow/dsl.ts";

export const buildWithExperts = wf.define("build-with-experts", (b) => ({
  // standing pool — spawned once, consulted on demand, torn down at run end
  experts: [
    { id: "solid-expert",    from: "solid-expert",
      prompt: "You are the SOLID/clean-code authority for this run. Stay IDLE-but-consultable; answer peers' design questions precisely from SOLID principles." },
    { id: "patterns-expert", from: "patterns-expert",
      prompt: "You are the design-patterns authority for this run. Stay IDLE-but-consultable; recommend/critique GoF & architectural patterns for peers on demand." },
  ],
  root: b.sequence([
    // 1) decompose the build into modules
    b.step({ id: "plan", from: "planner",
             prompt: "Break {{args.feature}} into independent modules. Return the module list.",
             outputSchema: ModulePlanSchema }),
    // 2) data-driven fan-out: one implementer per module — each spawned collaborate:true
    //    so it can ask_peer the solid-expert / patterns-expert WHILE implementing
    b.phase("implement",
      b.forEach({ id: "impl", over: "{{nodes.plan.output.modules}}",
        body: b.step({ id: "impl-item", from: "implementer",
          prompt: [
            "Implement module: {{item}}.",
            "You may consult peers: ask_peer peerName:'solid-expert' for SRP/OCP/DIP review,",
            "ask_peer peerName:'patterns-expert' for the right pattern. Apply their guidance.",
          ].join(" "),
          outputSchema: ImplResultSchema }) })),
    // 3) barrier review across all implementations
    b.step({ id: "review", from: "reviewer",
             prompt: "Review all modules for SOLID + pattern adherence: {{nodes.impl.output}}",
             outputSchema: ReviewSchema }),
  ]),
}));
```

Execution: the engine mints the anchor, spawns `solid-expert` + `patterns-expert`
(`persistent`+`collaborate`) under it, runs `plan` → `forEach` implementers (each
`collaborate:true` under the same anchor, so `ask_peer peerName:"solid-expert"` reaches the
standing expert and blocks until answered) → the barrier `review` — then the `finally` kills
the anchor, reaping both experts and every implementer in one recursive call.

---

## 5. Extensibility (Open/Closed proof) + the canonical worked example

### 5.1 Adding a node type touches only new code + 3 additive lines

To add, say, `human-approval` (pause until a human answers via the existing
`mcp__orchestrator__ask_user` channel):

1. **contracts/** — add `HumanApprovalNodeSchema` as a new member of the
   `WorkflowNodeSchema` discriminated union (additive).
2. **core/src/workflow/executors/humanApproval.ts** — new file implementing
   `StepExecutor<"human-approval">`.
3. **manager/container.ts** — one line: `registry.register(humanApprovalExecutor)`.

`WorkflowEngine.runNode` never changes — it looks up `registry.get(node.type)` and calls
`execute`. Existing executors never change. The declarative spec gains the new node for free.
Identical to how a new `GoalCheckStrategy` or `AgentBackend` is added today. The same
procedure adds `sleep`/`timer`, `map`/`filter`/`dedup`/`tally` (the v1.x glue nodes),
`subWorkflow`, or a future `compensate` (Saga). A new **front-end** (e.g. a YAML dialect) is
also Open/Closed: write a parser that emits the `WorkflowNode` IR; the engine is untouched.

### 5.2 The "3 research → 5 analysis → 2 planning" example (recommended declarative form)

Barrier topology (analysis synthesizes ALL research; planning synthesizes ALL analyses).
Via the trusted Builder, lowering to the IR; the orchestrator can emit the equivalent
declarative spec for the dynamic path:

```ts
export const researchAnalysisPlanning = wf.define("research-analysis-planning", (b) => ({
  experts: [],   // none for this flow
  root: b.sequence([
    b.phase("research",
      b.parallel(Array.from({ length: 3 }, (_, i) =>
        b.step({ id: `research-${i}`, from: "researcher",
                 prompt: `Research angle ${i} of: {{args.topic}}`,
                 outputSchema: ResearchSchema })))),
    b.phase("analysis",
      b.parallel(Array.from({ length: 5 }, (_, i) =>
        b.step({ id: `analysis-${i}`, from: "analyst",
                 prompt: `Analysis pass ${i} over the full corpus: {{nodes.research-*.output}}`,
                 outputSchema: AnalysisSchema })))),
    b.phase("planning",
      b.parallel(Array.from({ length: 2 }, (_, i) =>
        b.step({ id: `plan-${i}`, from: "planner",
                 prompt: `Produce plan ${i} from all analyses: {{nodes.analysis-*.output}}`,
                 outputSchema: PlanSchema })))),
  ]),
}));
```

- Static fan-out (`3`, `5`, `2`) uses host `Array.from` in the Builder; **data-dependent**
  fan-out (count known only at runtime) uses a `forEach` node over a bound list — the reason
  `forEach` is a reified node, not host JS (the declarative front-end has no loops).
- Each `parallel` is a true barrier (`Promise.all` of the joins); analysis prompts embed the
  full research corpus via `{{nodes.research-*.output}}` bindings (typed via `submit_step_output`).
- For the pipeline variant (each analysis depends on ONE research item, no barrier), use a
  `pipeline` node — remembering the §3.2 correctness note (independent per-item chains).

---

## 6. Phased implementation plan

Each phase is ordered `contracts → core → infra → manager`, with the Eos precedent to clone.

### Phase v1 (MVP) — usable, crash-correct, with the expert pool

**contracts/**
1. `workflow-node.ts` — `WorkflowNode` union: `step`, `sequence`, `parallel`, `pipeline`,
   `forEach`, `conditional`, `loopUntil`, `phase`, `subWorkflow`. *(clone the discriminated-union
   style of `commands/defs.ts`)*
2. `workflow.ts` — `WorkflowDefinitionSchema` (+`experts[]`), `WorkflowRunSchema`,
   `WorkflowStepSchema`, status enums, `WorkflowToolRequestSchema`, `StepResultRequestSchema`,
   `ExpertSpecSchema`, records. *(clone `worker-definition.ts` + `loop.ts`)*
3. `events.ts` — append `workflow_run_started/_done/_failed`, `workflow_step_*` to
   `WorkerEventTypeSchema`.
4. `http.ts` — `ROUTES`: `workflows`, `workflowRun(id)`, `workflowStepOutput(id)`; request/
   response schemas. *(clone the loop/worker-definition ROUTES entries near `:1636`)*
5. `core/src/ports/EventBus.ts` — append `"workflow:run-change" | "workflow:step-change"`.

**core/**
6. Ports: `StepExecutor`, `StepExecutorRegistry`, `WorkflowEngine`, `WorkerSpawnPort`,
   `ProgressSink`, `ConcurrencyGate`, `WorkflowRunRepo`, `WorkflowStepRepo`,
   `RuntimeWorkflowDefinitionStore`, `WorkflowDefinitionSource`. *(clone `LoopStateRepo`,
   `RuntimeWorkerDefinitionStore`, `WorkerDefinitionSource`)*
7. `core/src/workflow/`: `engine.ts` (runNode skeleton + memoized replay), `registry.ts`,
   `bindings.ts`, `predicate.ts`, `concurrency.ts`, `dsl.ts`, `executors/{step,sequence,
   parallel,pipeline,forEach,conditional,loopUntil,phase,subWorkflow}.ts`. *(engine skeleton
   clones `runLoopTick` fixed precedence; registry clones `makeStrategyFor`)*
8. Use-cases: `RunWorkflow`, `ResumeWorkflow`, `StopWorkflow`, `CreateWorkflowDefinition`.
   *(clone `attachLoop`/`stopLoop` — repo writes + `bus.publish`, clock via port)*

**infra/**
9. `MigrationRunner.ts` — append `workflow_definitions`, `workflow_runs`, `workflow_steps`.
   *(clone migrations 047/050)*
10. `SqliteWorkflowRunRepo`, `SqliteWorkflowStepRepo`, `SqliteRuntimeWorkflowDefinitionStore`.
    *(clone `SqliteLoopStateRepo` / `SqliteRuntimeWorkerDefinitionStore`)*
11. `infra/src/workflow/FileWorkflowDefinitionSource.ts`. *(clone `FileWorkerDefinitionSource`)*

**manager/**
12. `WorkerSpawnAdapter` — `spawnAndAwait` (`spawnWorkerHandler.run` + `PendingJoin` over
    `worker:report`/`worker:exit`), `spawnExpert`, `killWorker`, `mintRunAnchor`. *(the join is
    net-new; spawn clones `spawn_worker` MCP tool's request building)*
13. `submit_step_output` tool + `POST /workers/:id/step-output` route (validate, publish, **persist
    step output durably**). *(clone `send_message_to_parent` + `routes/workers.ts:577`)*
14. `EventBusProgressSink`; `WorkflowService` (driver); `run-workflow`/`create-workflow`
    command handlers; the single `workflow` MCP tool + `submit_step_output` in `tools/registry.ts`;
    `routes/workflows.ts`. *(handlers clone `spawn-worker.ts`; routes clone `loops.ts`)*
15. `config.workflow` block (`maxConcurrentSteps`, `defaultStepTimeoutMs`, `enabled`) +
    `mergeConfig` branch; `"workflows"` in `USER_DATA_ENTRIES`; container wiring (build
    registry, register executors, construct repos + per-run gate); `daemon.ts` route
    registration.
16. **Crash-correctness:** `reArmWorkflows()` boot hook (`runs.listActive()` → reconcile each
    running step from child worker state + parent-timeline `worker_report` + `queued_messages`)
    wired in `daemon.ts` alongside `reArmLoops` (`:414`). *(clone `loop-rearm.ts`)*

**v1 acceptance:** run a stored or inline workflow; typed step bindings via `submit_step_output`
(text fallback when no schema); barrier `parallel`, `pipeline`, data-driven `forEach`; the
expert pool spawns/teardowns; per-run concurrency cap; step results persist on each report and
in-flight runs survive a daemon restart (surfaced as resumable).

### Phase v1.x — adaptive power + auto-continue

- **Glue nodes** `map` / `filter` / `dedup` / `tally` / `accumulate` (executors + union members
  + `register()` lines) to lift the dynamic path toward code power (§3.2).
- **`loopUntil` iteration metadata** in predicate bindings (`iteration`/`lastResult`/`lastCount`).
- **Auto-continue resume:** `ResumeWorkflow` re-walks the tree past journaled steps and spawns
  the next nodes (the only genuinely deferred resume piece).
- **Global ConcurrencyGate** composed under the per-run gate (if concurrent runs land).
- **Declarative dynamic front-end hardening** + `create_workflow` round-trip tests.

### Phase later

- **Saga / `compensate`** executor + reverse-walk of the journal (undo worktree-mutating steps).
- **`workflow_events` dedicated timeline** table if audit must outlive `events` pruning.
- **`workflow_run_id` column on `workers`** for O(1), generation-agnostic budget accounting
  (`SELECT SUM(cost_usd) WHERE workflow_run_id = ?`) instead of `listByParent` summation.
- **Cross-level mesh** (group/team id decoupled from `parent_id`) if grandchildren must consult
  the expert pool (O1).
- **Public code-exec path** (sandboxed `vm`) only if a strong need emerges (deliberately not v1).

---

## 7. Risks, open questions, decisions-needed

| Ref | Item | Status / position |
|---|---|---|
| **C1** | code-DSL vs declarative IR (dynamic path) | **Resolved:** declarative IR is the one execution target; code = trusted author-time Builder. *Risk:* dynamic path is capped below code power (no inline glue) → mitigate with v1.x glue nodes + loop metadata. State the cap honestly. |
| **Typed I/O** | `submit_step_output` vs free-text | **Resolved:** build the tool/route/Zod (critical path); text fallback when no `outputSchema`. *Risk:* net-new IPC — must persist output durably in the handler. |
| **Resume** | journal vs replay | **Resolved/raised:** durable step persistence + boot reconcile are **mandatory v1** (`worker:report` ephemeral; resumed worker never re-reports); auto-continue is v1.x. |
| **C4** | run anchor identity | **Resolved:** synthetic anchor row, `parentId = orchestrator selfId`, `is_orchestrator=1`, null pid/port/session; set mode explicitly on every spawn; engine self-heals the spurious boot-reconcile `DONE`/`worker:exit`. |
| **C5** | determinism guard | **Resolved:** `Clock`/`IdGenerator` ports; no `Date.now`/`Math.random` in `core/src/workflow`; optional lint guard (clone `backend-kind-literal-guard`). |
| **C6** | stop/abort | **Resolved:** status `stopped` + abort signal + `killWorker(anchorId)`; joins reject on `worker:exit`; filter the anchor's own exit. |
| **Report-hold** | held reports + step loops | **Resolved (constraint):** step-workers must NOT arm their own loops; the join waits for the **released** report. |
| **Concurrency** | no native cap | **Resolved:** in-engine `ConcurrencyGate` at the leaf choke point, per-run from config; global gate composable later. *Risk:* N concurrent runs × cap with no global gate. |
| **O1** | cross-level mesh | **Open (recorded):** the mesh is flat under one `parent_id`; grandchildren cannot consult the pool. v1 requires consulting workers to be direct children of the anchor; cross-level needs a group/team id (later). |
| **O2** | sandbox for dynamic code | **Deferred:** no public code-exec path in v1; declarative IR removes the need. Revisit only with a concrete need (sandboxed `vm`). |
| **O3** | run-timeline pruning | **Decided v1:** reuse `events` keyed by `runId` (free pruning/pagination); a very long run can lose early step rows → dedicated `workflow_events` table later if a full audit trail is required. |
| **O4** | budget granularity | **Decided v1:** sum `cost_usd` over `listByParent(anchorId)` (add a `SELECT SUM` helper to `WorkerRepo`); `listByParent` is one level → add a `workflow_run_id` column on `workers` later for generation-agnostic O(1) budget. |
| **O5** | await timeout for experts | **Watch:** `config.collaborate.awaitTimeoutMs` (default 120s) bounds how long a step blocks for an expert; long flows may need it raised. |

---

## 8. Appendix — pointers to the four findings

All under `…/99d5da31-…/scratchpad/workflow-research/`:

- **`01-eos-orchestration.md`** — spawn/collect API (`spawnWorker` `SpawnWorker.ts:132`,
  `spawnWorkerHandler` `spawn-worker.ts:17`), EventBus join seams, the **peer-mesh + persistent
  worker mechanics** that back §4 (`Peers.ts`, `ask_peer`, `PeerRequestPump`, `KillWorker`),
  ownership/cleanup, the no-typed-result gap.
- **`02-eos-state.md`** — contracts/Zod SSOT, the `worker_loops` entity precedent, SQLite
  persistence + migrations, the append→publish→SSE chain, `~/.eos` stores, config; the
  durability addendum that raised resume to mandatory-v1.
- **`03-workflow-engine.md`** — execution-model survey (Temporal/Inngest/Restate/Prefect/Saga),
  the DSL primitive set + semantics, determinism/resume, Zod step I/O, the per-step algorithm,
  the worked examples; the C1 reconciliation acceptance + the `pipeline` correctness note + the
  "what's lost" (inline glue) analysis.
- **`04-architecture.md`** — clean-arch layering, the GoF/architectural pattern map (+ rejected
  patterns), the core port interfaces, the `WorkflowNode` IR, the Open/Closed registry seam, the
  full module/folder layout; the C1 declarative-IR resolution and the `experts[]`-via-`run()`-
  skeleton decision.

*Consultation record:* every open decision above was confirmed by direct follow-up with the
owning peer — orchestration (standing-expert mechanics, anchor identity, teardown), state
(event ordering, crash durability, budget), engine (C1 acceptance, pipeline + glue caveats,
resume revision), architecture (expert-pool placement, ConcurrencyGate). Where a peer could
not resolve an item (cross-level mesh, O1), it is recorded as open, not invented.
