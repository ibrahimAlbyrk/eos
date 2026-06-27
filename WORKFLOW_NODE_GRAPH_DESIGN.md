# Eos Workflow System — Node-Graph Engine + Typed Worker-Execution Contract

Status: DESIGN ONLY. No runtime code changed by this document. Branch
`feat/eos-workflow-system`. Every proposed change cites current source at
`file:line` (verified against the working tree, June 2026; recent commits
`7cfe115` / `bd47a66` / `80147b6` already changed step signaling — this doc
reflects the CURRENT code, not the historical diagnosis).

This is the single permanent design for two coupled bodies of work:

- **Part A — Node-Graph Evolution.** Grow the workflow data model from a
  single-rooted *tree* into a declarative *node graph* (one INPUT → many freely
  wired nodes → one OUTPUT), executed deterministically with no LLM driving it,
  while KEEPING the existing deterministic engine.
- **Part B — Typed Worker-Execution Contract.** Fix how a worker-agent node
  produces its result: replace the "scrape the last assistant message" capture
  with an explicit **typed output tool** + an explicit **status**, and give
  workflow worker-agents a **dedicated, workflow-specific system prompt + tool
  surface** (a third DPI role). This is the structural fix for the false-pass
  class and is **independently shippable on today's tree engine** — it is the
  natural first build phase and a prerequisite for typed ports in Part A.

Part C is the unified phased build path. Part D is the decision log, containing both resolved decisions and still-open items.

> This document is self-contained. It supersedes and folds in the prior
> scratchpad investigation (8 areas + 5 dimensions) and the historical
> `WORKFLOW_ISSUES_DIAGNOSIS.md`; those files are not part of the repo and a
> future implementer needs nothing beyond this file plus the cited source.

---

# PART A — NODE-GRAPH EVOLUTION

## A0. Vision and the headline finding

Target (operator's words, faithfully): *build a workflow as a NODE GRAPH that
runs deterministically with NO orchestrator/LLM driving it. One INPUT →
potentially THOUSANDS of freely-connected nodes (each a different function: run a
worker, run a script, transform, branch, …) → one OUTPUT. Authored
declaratively, node-editor style (n8n / ComfyUI / Node-RED), executed
input→output deterministically without an LLM assembling or launching it.*

**Headline finding the whole design is built around: the deterministic, LLM-free
execution core is already the asset the vision wants — KEEP it.** What diverges is
the *shape* it interprets (a tree, not a graph) and the *front door*
(orchestrator-only — no human/program/editor path). Neither divergence requires
discarding the core.

In one line: **keep the engine (A1/A3), regrow the data model into a graph (A2),
build the missing human/program/editor front door (A6)** — and (Part B) make each
worker-node's output a typed tool call instead of a scraped message.

## A1. Verdict — dimension by dimension

### A1.1 Data model — DIVERGES, must change (vocabulary already fine)

Today a `WorkflowDefinition` is a single-rooted TREE: one
`root: WorkflowNodeSchema` (`contracts/src/workflow.ts:35`), where `WorkflowNode`
is a recursive 16-member discriminated union
(`contracts/src/workflow-node.ts:311-330`) whose only structural relations are
parent→child containment — `children`/`stages`/`body`/`then`/`else`
(`core/src/workflow/node-scope.ts:52-68` `childrenOf`). There are **no edges, no
ports, no INPUT/OUTPUT node types**. "Input" is the run `args`; "output" is the
root node's result (`engine.ts:159-162`).

ALREADY fine, KEPT: the **node vocabulary**. The 16 types
(`workflow-node.ts:334-351`) already cover every function class the vision names:
`step` = run a worker agent, `script` = run a custom script,
`transform/map/filter/dedup/tally/accumulate` = transform data, `conditional` =
branch, `subWorkflow` = sub-graph. These survive verbatim as graph *node kinds*.

MUST change: the **topology** (tree-of-containers → flat `nodes[]` + `edges[]`
DAG), the **connection model** (string `{{nodes.id.output}}` bindings → explicit
typed edges between ports), and the **I/O framing** (add first-class `input` /
`output` node kinds).

### A1.2 Engine — MATCHES at the core, KEEP (one bug, one soft seam)

The control/routing/branching/sequencing loop is already pure deterministic code,
LLM-free. The crown jewels to preserve unchanged:

- The `runNode` Template Method (`engine.ts:65-96`): memo-check journal → journal
  start → `registry.get(node.type).execute` (`engine.ts:84`) → journal result →
  write output to the binding scope (`engine.ts:86`). It never branches on
  `node.type`.
- Pure predicate evaluator (`core/src/workflow/predicate.ts:11-32`) — a closed
  `eq/exists/and/or` operator set, never an LLM.
- Crash-safe resume: journal `workflow_steps` PK `${runId}:${nodeId}`
  (`engine.ts:175-177`), memoized replay of `passed` nodes (`engine.ts:68-74`),
  boot re-arm (`manager/services/workflow-rearm.ts:50-77`).
- One `CountingSemaphore` per run at the single leaf choke point
  (`engine.ts:152`, applied at `core/src/workflow/executors/step.ts:68`).
- Determinism discipline: time/identity only via injected `Clock`/`IdGenerator`,
  enforced by `core/src/__tests__/workflow-determinism-guard.test.ts:25-35` (fails
  the suite on any `Date.now(`/`Math.random(` under `core/src/workflow/`).

The ONLY engine-level structural divergence: `execute()` calls
`this.runNode(def.root, execCtx)` (`engine.ts:159`) — a single tree root. That one
dispatch line is the entire seam between "tree walk" and "graph schedule."
Everything beneath it is graph-agnostic.

One real bug: **glob fan-in aggregation is nondeterministic** —
`{{nodes.prefix-*.output}}` iterates the binding `Map` in completion order
(`core/src/workflow/bindings.ts:81-88`), so a concurrently-filled fan-in list can
reorder between runs. The graph model retires this in favor of ordered edges
(A3.4). One soft seam — per-step output capture — is Part B's subject.

### A1.3 Authoring/launch — DIVERGES, must change (engine untouched)

The engine is orchestrator-free at runtime, but every authoring/launch path is
orchestrator-coupled:

- The only first-class entry is the `workflow` MCP tool,
  `visibility: "orchestrator"` (`manager/tools/defs/workflow.ts:60`, mode enum at
  `:62`).
- NO CLI verb (`manager/cli/commands/registry.ts:21-40` lists no workflow
  command).
- NO UI — the Workflows tab is a literal placeholder ("Coming soon."
  `app/ui/src/views/workflows/WorkflowsEmpty.jsx:12`, rendered by
  `WorkflowsView.jsx:26`).
- HTTP `POST/PUT /workflows` (`manager/routes/workflows.ts:31-45`,`:60`) is
  loopback-only and **requires an `owner` agent id** (`:31-32`); completion is
  delivered into that owner's agent inbox (`container.ts deliverCompletion`).

This is all **additive front-end work**; the engine is reusable as-is.

## A2. Target data model — the node-graph representation

A flat graph: `nodes[]` + `edges[]`, explicit `input`/`output` node kinds, a
node-kind registry, typed input/output ports, edges wiring an upstream output
port to a downstream input port. New file `contracts/src/workflow-graph.ts`
(sibling of `workflow-node.ts`), versioned so it coexists with the v1 tree.

```ts
// contracts/src/workflow-graph.ts  (NEW)
import { z } from "zod";
import { ExpertSpecSchema } from "./workflow.ts";

// Port value types — the authoring-time type system for edges. `json` = a typed
// object whose shape is the node's outputSchema (today only `step` carries one,
// workflow-node.ts:197); `any` = untyped (today's default everywhere).
export const PortTypeSchema = z.enum(["any","string","number","boolean","object","array","json"]);

export const NodePortSchema = z.object({
  name: z.string(),                      // port id, unique within the node's side
  type: PortTypeSchema.default("any"),
  required: z.boolean().optional(),      // a required input that never resolves fails the node
  schema: z.unknown().optional(),        // JSON-Schema when type==="json" (reuses compileJsonSchema)
});

export const GraphNodeSchema = z.object({
  id: z.string(),                        // UNIQUE within the graph (enforced — A3 / superRefine)
  kind: z.string(),                      // registry key: input|output|worker|script|transform|
                                         //   map|filter|dedup|tally|accumulate|branch|merge|loop|subGraph
  label: z.string().optional(),
  config: z.unknown().optional(),        // kind-specific params (prompt, from, model, fn, predicate, schema, …)
  inputs: z.array(NodePortSchema).optional(),
  outputs: z.array(NodePortSchema).optional(),
  ui: z.object({ x: z.number(), y: z.number() }).optional(), // canvas layout — ignored at runtime
});

export const GraphEdgeSchema = z.object({
  id: z.string().optional(),
  from: z.object({ node: z.string(), port: z.string().default("out") }),
  to:   z.object({ node: z.string(), port: z.string().default("in") }),
});

export const WorkflowGraphSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.literal(2),                 // discriminates graph(v2) from tree(v1)
  experts: z.array(ExpertSpecSchema).optional(),   // KEPT verbatim
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
}).superRefine((g, ctx) => {
  // structural invariants enforced at parse (today nothing validates id uniqueness):
  //  - exactly one `input` node and at least one `output` node
  //  - node ids unique; every edge endpoint references an existing node+port
  //  - the graph (minus encapsulated loop bodies) is acyclic
});
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;
```

How this differs from today's recursive union (`workflow-node.ts:311-330`):

| Today (v1 tree) | Target (v2 graph) |
|---|---|
| One `root` (`workflow.ts:35`); neighbors = `children/stages/body/then/else` | Flat `nodes[]`; neighbors = `edges[]` adjacency |
| 16-member `z.discriminatedUnion("type", …)` — closed at the type level | Open `kind: z.string()` resolved by a **kind registry** (mirrors `registry.ts get(type)`) |
| Connections implicit (containment) + string `{{nodes.id.output}}` | Explicit `{from:{node,port}, to:{node,port}}` edges |
| No INPUT/OUTPUT node; input=`args`, output=root | First-class `input` (seeds args) + `output` (selects final value) kinds |
| `outputSchema` only on `step`, runtime-only check | Any node may declare typed `outputs[]`; type-checked at authoring time |
| ids unique by author convention, unenforced | ids unique, enforced in `superRefine` |

The kind registry mirrors the existing executor registry exactly: today
`InMemoryStepExecutorRegistry` maps `type → StepExecutor` (`registry.ts get(type)`)
and `registerBuiltinExecutors` wires the builtins
(`core/src/workflow/register-builtins.ts:28-33+`). The graph keeps that registry;
"node kind" is "executor key," now also carrying a declared port signature so the
editor can render handles and type-check edges. Adding a kind stays "new file +
one register line."

**Scaling to thousands of nodes.** Flat arrays are the enabler: parse/index is
O(N+E) over arrays (no deep `z.lazy` recursion ceiling); build an adjacency index
once at load; topological scheduling is Kahn's algorithm, O(N+E); live concurrency
stays bounded by the existing per-run `CountingSemaphore` (`engine.ts:152`)
regardless of N; persisted as one JSON blob (the file/runtime/SQLite stores
already hold a whole definition).

## A3. Execution model — deterministic DAG scheduling that reuses the engine

The graph executes by **readiness-driven (topological) scheduling**: a node fires
when every incoming edge has a resolved value. This reuses the engine's existing
strengths and changes exactly one dispatch decision.

### A3.1 The readiness loop (Kahn's algorithm), reusing `runNode`

```
scheduleGraph(graph, execCtx):
  index = adjacency(graph.edges)               // Map<nodeId,{in,out}>, O(N+E)
  indeg = incoming-edge count per node
  ready = nodes with indeg 0                    // exactly the `input` node in a well-formed graph
  seed input-node output := execCtx.args        // INPUT → args (replaces bindings.ts args seed)
  while ready not empty:
    fire all currently-ready nodes concurrently:        // bounded by ctx.concurrency (engine.ts:152)
      inputs = resolve incoming edges → Record<port, value>   // read upstream outputs from BindingScope
      result = ENGINE.runNode(node, {...ctx, inputs})  // ← the SAME Template Method (engine.ts:65-96)
      write result.output to BindingScope under node.id (+ per-port)   // engine.ts:86, unchanged
      for each outgoing edge: if all of target's inputs resolved → enqueue target
  return the `output` node's resolved value         // replaces engine.ts:159-162 root roll-up
```

REUSED unchanged: `runNode` (`engine.ts:65-96`, journaling/memo/progress are
per-node concerns); the per-run `CountingSemaphore` (`engine.ts:152`, leaf choke
at `step.ts:68`); the journal + resume + boot re-arm (PK `${runId}:${nodeId}` is
already node-keyed, `engine.ts:175-177`; on resume, seed `BindingScope` from
journaled `passed` nodes and schedule only the unjournaled frontier;
`workflow-rearm.ts` iterates step rows, not tree nodes); `Clock`/`IdGenerator`
determinism (the new `scheduler.ts` lives under `core/src/workflow/`, already in
the guard's scope); the leaf executors (read resolved input-port values instead
of, or in addition to, string bindings — A5); `BindingScope` (reused as the run
value store: edges read/write by `nodeId[.port]`).

CHANGES: **one line.** `engine.ts:159`
`const result = await this.runNode(def.root, execCtx)` becomes
`const result = await this.scheduleGraph(graph, execCtx)`. The surrounding
`execute()` lifecycle (anchor mint, expert spawn, result persist
`engine.ts:160-162`, guaranteed teardown) is graph-agnostic and stays verbatim.
The run output becomes "the `output` node's value" instead of "the root's value."

### A3.2 Branching without losing determinism

A `branch` node evaluates the existing pure predicate (`predicate.ts:11-32`,
reused verbatim) and **activates exactly one outgoing edge**; inactive edges carry
a `skipped` token instead of a value. Skip-propagation drains the DAG
deterministically: a node fires when every incoming edge is *resolved* (a value or
`skipped`); it runs iff at least one required input is a real value; if all
required inputs are skipped, it emits `skipped` downstream (structural, timing
independent). A `merge`/join node (new kind) takes the first non-skipped input by
**edge-declaration order**, so a diamond `A→{B,C}→D` re-converges deterministically.
This generalizes today's binary `conditional` then/else (`conditional.ts:13`) to
N-way switches and explicit joins.

### A3.3 Loops without cycles

A pure readiness scheduler deadlocks on a true cycle. So the top-level graph stays
a **DAG**, and iteration is an encapsulated **`loop` node** whose `config.body` is
a nested sub-graph re-scheduled per iteration until a predicate holds — exactly
today's `loopUntil`/`forEach` semantics but as a graph node. Per-iteration id
scoping reuses the proven `scopeNodeIds` deep-clone-and-suffix approach
(`node-scope.ts:24-27`), generalized from a body subtree to a body sub-graph, so
journal PKs and bindings never collide across iterations.

### A3.4 Fix the known nondeterminism

The glob fan-in (`bindings.ts:81-88`, Map completion order) is **retired as a
wiring mechanism**: in the graph, fan-in is N explicit edges into a `merge` node,
resolved in **edge-declaration order** — deterministic by construction. The glob
survives only inside the legacy tree→graph compile path (A4/Phase 1), made
deterministic by sorting matched ids in definition order. A new guard test
(`workflow-fanin-determinism.test.ts`) asserts a fan-in's aggregate order is
stable under concurrent completion.

## A4. The key architectural decision — how much engine to reuse

Three honest options, then a pick.

**(A) Compile the graph DOWN to the tree-walk engine** (graph = front-end, tree =
runtime IR). Pro: zero engine change, perfect back-compat, fastest. Con: it is a
**façade** — the runtime stays a tree with string bindings, the exact model the
vision moves *away* from; topo-layering inserts a barrier between every layer
(each `parallel` is a barrier), over-synchronizing at thousands-of-nodes scale.
Satisfies "author as a graph" but **not "execute as a graph."**

**(B) A NEW graph scheduler ALONGSIDE the tree engine.** Pro: clean DAG-native
scheduler; tree engine untouched. Con: **two engines forever** — the run/resume
lifecycle (`engine.ts:99-170`) and boot re-arm (`workflow-rearm.ts`), the most
safety-critical code, get duplicated or awkwardly shared, doubling drift risk.

**(C) GENERALIZE `runNode`'s tree-walk into a readiness-driven graph scheduler,
keeping the node executors** (graph = runtime IR; tree lowers INTO it). Pro:
maximal reuse, **one runtime.** `runNode` is untouched; the lifecycle is untouched
except the single dispatch line `engine.ts:159` → `scheduleGraph`. Journal,
semaphore, resume, re-arm, clock/idgen, and every leaf executor survive verbatim.
Fan-in determinism is fixed structurally. Legacy trees stay alive via a small
`treeToGraph` compiler run at load, so there is exactly ONE execution path. Con:
touches the proven `engine.ts` (mitigated: the change is a single dispatch swap;
the existing engine/adapter/rearm tests + the two builtins are the back-compat
regression gate). Branch skip-propagation (A3.2) and loop sub-graph scoping
(A3.3) are genuinely new, additive, well-contained logic.

### Decision: (C) — generalize into a single readiness-driven graph scheduler.

The vision is explicit that the workflow *executes* as a graph, not merely that it
is *drawn* as one — that rules out (A). Between (B) and (C), the deciding factor is
seam size: the tree-vs-graph difference in the current engine is **literally one
line** (`engine.ts:159`); everything valuable — the `runNode` Template Method, the
per-node journal PK (`engine.ts:175-177`), memo-replay (`engine.ts:68-74`), the
semaphore (`engine.ts:152`), guaranteed teardown, boot re-arm — is per-node and
run-level, not tree-shaped. (B) duplicates all of that to gain nothing (C) doesn't
already have.

### File-level impact of (C)

SURVIVES UNCHANGED: `engine.ts` `runNode` (`:65-96`) and the lifecycle
(`:99-170`) except the dispatch swap at `:159`; `concurrency.ts`, `bindings.ts`,
`predicate.ts`; `core/src/ports/StepExecutor.ts`, `registry.ts`, the run/step
repos; leaf executors `step.ts`/`script.ts`/`glue.ts` (port-input shim added, A5);
`workflow-rearm.ts`, `WorkerSpawnAdapter.ts` (modified by Part B, not by the graph
swap), the SQLite repos, `json-schema-validator.ts` (reused as port-type
validator).

CHANGES: `engine.ts:159` (dispatch to `scheduleGraph`); `contracts/src/workflow.ts`
(`WorkflowDefinition` gains a v2 graph variant, a `version`-discriminated union of
v1 tree + v2 graph); `node-scope.ts` (`scopeNodeIds`/`collectIds`/`childrenOf`
gain sub-graph analogs for `loop` bodies); `WorkflowService.ts:67-106` (accept v2
graphs); `manager/routes/workflows.ts` (operator-owned run mode, A6.4);
`infra/src/workflow/FileWorkflowDefinitionSource.ts` (accept v2 graph docs).

NEW: `contracts/src/workflow-graph.ts` (A2); `core/src/workflow/scheduler.ts`
(A3.1); `core/src/workflow/tree-to-graph.ts` (back-compat compiler);
`core/src/workflow/executors/{input,output,branch,merge,loop}.ts`;
`core/src/__tests__/workflow-fanin-determinism.test.ts`;
`manager/cli/commands/workflow.ts` (A6.3); the node-editor canvas under
`app/ui/src/views/workflows/` (A6.2).

## A5. Data flow on edges — typed ports replace string binding

Today data flow is implicit string-binding: a step's `prompt` carries
`{{nodes.id.output[.sub]}}` / `{{args.*}}` tokens substituted by `BindingScope`
(`bindings.ts:44-46`) before the worker spawns; many→one fan-in is the glob
(`bindings.ts:77-91`). The wiring is text inside a prompt, invisible to any
structural validator.

Target: an **edge carries the value** of a source output port to a dest input
port. The scheduler resolves a node's incoming edges into a `Record<port, value>`
and hands it to the executor — no string templating for *wiring*.

KEEP (demoted to two narrow roles): **intra-node prompt interpolation** (a
`worker` node's `prompt` interpolates *its own resolved input ports*, e.g.
`{{in.research}}`; the `BindingScope.resolve` machinery, including the
`resolveStrict` loud-unresolved guard `bindings.ts:54-63` already wired into
`step.ts:86-98`, is reused, now resolving from a per-node `inputs` map) and **the
legacy tree→graph compile path** (keeps cross-node `{{nodes.*}}`, made
deterministic, so the two builtins and any on-disk tree keep running).

RETIRE from the new graph authoring surface: raw cross-node
`{{nodes.id.output}}` wiring and the `{{nodes.prefix-*.output}}` glob — replaced by
explicit edges / `merge` nodes, eliminating the fan-in nondeterminism (A3.4).

**Typed output → port types.** Today `outputSchema` lives only on `step`
(`workflow-node.ts:197`) and is validated by the manager-side `compileJsonSchema`
(`manager/services/json-schema-validator.ts:33-42`, attached via
`attachOutputValidators` `:47-53`, called in `WorkflowService.ts:82`). In the
graph, that becomes the **output port type**: a `worker` node declares
`outputs:[{name:"out", type:"json", schema:{…}}]`; the *same* `compileJsonSchema`
validator runs at the port boundary (DIP intact — core depends on the
`ZodLike{safeParse}` duck-type at `step.ts:34-39`, the manager supplies the
concretion). Downstream input ports declare expected types; the editor validates
edge type-compatibility at authoring time and the scheduler re-validates at
runtime. **Part B makes this port value STRUCTURAL** — it arrives as a typed tool
argument rather than JSON scraped from prose — so the typed-output port and the
worker-execution contract are the same mechanism seen from two sides.

**Product call (retire vs keep string-binding).** Recommendation: **KEEP**
string-binding for the two narrow roles above, **RETIRE** it from new graph
authoring. Zero migration for existing definitions; edges are the one true wiring
model going forward. A full rip-out waits until no tree definitions remain on disk.

## A6. Authoring surface — the orchestrator-free front door

Five surfaces; the orchestrator becomes ONE optional author among them.

**A6.1 Declarative graph file format (zero LLM).** A `.json` (or `.md` + YAML
frontmatter, matching the existing dual format) carrying
`{name, version:2, nodes[], edges[]}`. Drop into `~/.eos/workflows/` or project
`.eos/workflows/` — `FileWorkflowDefinitionSource` already reads and validates
those dirs and re-reads per `list()`. Extend it to accept v2 graph docs alongside
v1 trees (discriminate on `version`). **This is the literal "declarative, authored
by a human, no agent" path.**

**A6.2 Node-editor UI (headline UX deliverable).** Replace `WorkflowsEmpty`
(`WorkflowsEmpty.jsx:12`, rendered by `WorkflowsView.jsx:26`) with a canvas:
React-Flow-style draggable nodes, ports as handles, edges as bezier wires
(virtualized for thousands of nodes via `ui.{x,y}`); a **palette** sourced from
the live capability catalog the container already builds
(`container.ts:980` `renderCapabilityCatalog(workflowRegistry.types(),
workflowTransforms.names())`) so a newly-registered kind shows up automatically; an
**inspector** to edit the selected node's `config` and port types; **type-checked
edges** (reject incompatible connections at draw time); **Save** → `PUT
/workflows`, **Run** → `POST /workflows` (`routes/workflows.ts`), with live
progress over the existing SSE relay (`workflow:run-change` /
`workflow:step-change`, `routes/workflows.ts:7`) so nodes light up as they execute.

**A6.3 CLI verbs (zero-LLM launch).** Add `manager/cli/commands/workflow.ts` and
register it in `registry.ts:21-40`: `eos workflow run <file|name> [--arg k=v …]`
(load a v2 graph, `POST /workflows` with an operator owner, print the runId;
`--wait` polls `GET /workflows/:id`); `eos workflow validate <file>` (parse +
type-check offline — id-uniqueness / dangling-edge / cycle / port-type errors);
`eos workflow list` / `status <runId>` / `stop <runId>`.

**A6.4 First-class HTTP launch (operator-owned, agent-free).** Today `POST
/workflows` requires an `owner` agent id (`routes/workflows.ts:31-32`) and
completion is dispatched into that owner's agent inbox, so a non-agent caller's
completion no-ops. Add an **operator-owned run mode**: make `owner` optional →
default to a synthetic `operator` owner; when the owner is not a live agent, skip
the agent-inbox `deliverCompletion` and expose the result via the existing `GET
/workflows/:id` + SSE. The run itself already executes fine for any owner.

**A6.5 Reframe the orchestrator to optional.** The `workflow` MCP tool
(`tools/defs/workflow.ts:60`, `visibility:"orchestrator"`) stays as-is for the LLM
path. Reframe the prompt library (`manager/prompts/.../17-workflows.prompt.md`) so
workflows are pitched as a standalone graph engine the operator drives, with the
orchestrator as one optional caller. Doc/prompt change only.

The *functional* zero-orchestrator path is A6.1 + A6.3 + A6.4 on the A2/A3
engine; the *usable-at-scale* path adds A6.2.

## A7. Determinism contract (graph model)

**Guarantee.** Given the set of node outputs, the following are fully reproducible,
independent of wall-clock or completion timing: WHICH nodes run (readiness from the
static edge set + branch/skip propagation); the ORDER of fan-in aggregation
(edge-declaration order at `merge` nodes — A3.4); branch selection (pure
`predicate.evaluate`, `predicate.ts:11-32`); loop iteration counts; resume identity
(a `passed` node memo-replays its journaled output, `engine.ts:68-74`, PK
`engine.ts:175-177`).

**Explicitly NOT guaranteed** (and fine): the node *outputs* themselves — a
`worker`/`step` node runs an LLM; its output varies. Determinism is of the
*control/dataflow*, not the leaf work.

**Guards:** the clock/idgen guard (`workflow-determinism-guard.test.ts:25-35`); a
new `workflow-fanin-determinism.test.ts` pins fan-in order; a cycle in the
top-level graph is rejected at parse (`superRefine`); the backend-kind guard
(branch on capabilities, never on backend `kind` — `CLAUDE.md`,
`backend-kind-literal-guard`) carries to all new code.

---

# PART B — TYPED WORKER-EXECUTION CONTRACT (the new change)

## B1. The problem (current code, file:line)

A workflow `step` node (a worker-agent node) settles via **two paths** today, both
converging on `StepOutcome { workerId, signal, reportText }`
(`core/src/ports/WorkerSpawnPort.ts:43-47`):

1. **Report path** (explicit): the worker calls `send_message_to_parent` →
   `POST /workers/:id/report` → `bus.publish("worker:report", {text, held})`
   (`manager/routes/workers.ts:592`) → `WorkerSpawnAdapter.onReport`
   (`:268-278`) resolves with `signal: classifyReport(text)` and `reportText:
   text`.
2. **Last-assistant-message path** (the thing to REPLACE): the worker just answers
   and ends its turn with NO report. The daemon keeps the LAST assistant message
   text (`container.ts:893-894` `noteAssistantText`), and the WORKING→IDLE edge
   settles the join from that text (`WorkerSpawnAdapter.onStateChange`,
   `:295-306`), again via `classifyReport(text)` + `reportText: text`.

Both derive STATUS by running `classifyReport()` (`core/src/domain/report-signal.ts:9-15`)
over a blob of conversational text (first-line sniff), and derive OUTPUT by
treating that same text as the payload — or, when the node declares an
`outputSchema`, by scraping a JSON span out of the prose (`step.ts:72-80`,
`extractJson` at `core/src/workflow/executors/util.ts:35-45`, which falls back to
*any balanced `{...}` span anywhere in the text*). Status mapping is lenient
(`step.ts:47-49` `signalStatus`: `result` AND `unknown` both pass; only an explicit
`failed:`/`needs input:` first line fails).

This is the **false-pass class** ("ISSUE A" in the historical diagnosis): a
non-answer that lacks a token first line classifies `unknown` → passes; an answer's
incidental `{...}` can be mis-captured as the typed output. The last assistant
message is load-bearing for both payload and status, and that is exactly what the
operator wants inverted.

**Why `send_message_to_parent` is the wrong thing to specialize**
(`manager/tools/defs/send_message_to_parent.ts:4-17`): it is the universal
`visibility:"worker"` orchestrator-reporting channel carrying only `{ text }`,
status sniffed from the first line; it POSTs to `/workers/:id/report`, a route that
ALSO runs the loop hold-gate (`workers.ts:588`), the parent dispatch
(`workers.ts:640-650`), and opt-in auto-apply (`workers.ts:618-632`) — none of
which a deterministic node wants. Bending it to carry a typed payload would change
behavior for every non-workflow worker.

## B2. The output tool

**Name:** `workflow_step_output` (worker-visible → exposed to the agent as
`mcp__worker__workflow_step_output`). Named for today's "step" vocabulary; when
Part A renames steps to worker-kind nodes, this is the node's **output-port
emitter** (the name may migrate to `workflow_node_output` then — cosmetic).

**Arg schema** (`ToolDefinition.inputSchema`, a Zod raw shape like every def):

```ts
// manager/tools/defs/workflow_step_output.ts  (NEW)
inputSchema: {
  output: z.unknown().describe(
    "This node's output value — the typed payload other nodes consume. Must match the node's declared output schema if it has one."),
  status: z.enum(["done", "failed", "needs-input"]).describe(
    "done = the node's work is complete and `output` is the result; failed = could not complete; needs-input = blocked on missing input."),
  reason: z.string().optional().describe(
    "One-line why, REQUIRED for failed/needs-input. Becomes the node's failure output."),
}
handler: async (ctx, args) =>
  ctx.api("POST", `/workers/${ctx.selfId}/step-output`, { output, status, reason })
```

The tool's `output` is `z.unknown()` because the per-node JSON-Schema
(`node.outputSchema`) is **dynamic per step** — it is applied downstream in the
executor (B2.3), not baked into the static tool. (Optional refinement, B2.6: thread
the node schema into this arg's JSON-Schema *per spawn* so the SDK/CLI also
validate at the tool boundary and the model sees the exact shape.)

### B2.1 Status enum → NodeResult status

| `status` | `NodeResult.status` (`step.ts` returns) | output bound | rationale |
|---|---|---|---|
| `done` | `passed` | the typed `output` arg | the only success signal — positive, not "absence of failure" |
| `failed` | `failed` | `reason` (else `output`) | explicit self-declared failure |
| `needs-input` | `failed` (fail-closed; `reason` surfaced) | `reason` | no node-level pause primitive exists today; a blocked node fails the run loudly with its reason rather than silently passing a non-answer. (A future `paused` run status could change this — D2.) |

This **replaces** `classifyReport` + the lenient `signalStatus` (`step.ts:47-49`)
for workflow nodes: success now requires a positive `done`, never the mere absence
of a `failed:` token. `classifyReport` stays alive only for the general
orchestrator-report channel (non-workflow workers).

### B2.2 Settle event / route / bus topic

A **dedicated channel**, parallel to `worker:report` but off the general `/report`
route:

- **New route** `POST /workers/:id/step-output` (`manager/routes/workers.ts`,
  beside the `/report` route at `:577`). Body validated by a new
  `StepOutputRequestSchema` (`contracts/src/http.ts`): `{ output: z.unknown(),
  status: z.enum(["done","failed","needs-input"]), reason: z.string().optional() }`.
  The route does ONLY: (1) loop hold decision (B2.4); (2) publish the bus topic.
  It does **not** call `formatWorkerReport`, `dispatchMessage`, or auto-apply —
  that is the whole point of a separate channel vs `/report` (`workers.ts:600-655`).
- **New bus topic** `workflow:step-output` carrying
  `{ workerId, output, status, reason, held }`.
- **New adapter subscription** `WorkerSpawnAdapter.onStepOutput`
  (`manager/services/WorkerSpawnAdapter.ts`, mirroring `onReport` at `:268-278`):

```ts
private onStepOutput(payload: unknown): void {
  const workerId = readWorkerId(payload);
  if (!workerId) return;
  const entry = this.joins.get(workerId);
  if (!entry) return;
  entry.sawReport = true;                 // gates the exit-reject exactly like onReport (:286)
  if (readHeld(payload)) return;          // looped node: wait for the loop-goal release
  this.joins.delete(workerId);
  entry.resolve({ workerId, status: readStatus(payload), output: readOutput(payload), reason: readReason(payload) });
}
```

`StepOutcome` (`core/src/ports/WorkerSpawnPort.ts:43-47`) changes from
`{ workerId, signal, reportText }` to **`{ workerId, status: "done"|"failed"|"needs-input",
output: unknown, reason?: string }`**. The `worker:exit`-without-report
(`WorkerSpawnAdapter.ts:280-289`) and `stepTimeoutMs` (`:180-189`) paths keep
`reject(Error)` — a crash/hang is a thrown step failure (existing behavior,
unchanged).

### B2.3 How the executor consumes it (`step.ts` rewrite)

The no-schema and schema branches (`step.ts:101-131`) **collapse** — output always
comes from the tool arg; the schema (when present) validates that arg directly,
with NO `extractJson`:

```ts
const outcome = await spawnStep(node, ctx, basePrompt);   // StepOutcome { status, output, reason }
if (outcome.status !== "done") {
  return { output: outcome.reason ?? outcome.output, status: "failed", childWorkerIds: [outcome.workerId] };
}
const schema = asZod(node.outputSchema);
if (!schema) return { output: outcome.output, status: "passed", childWorkerIds: [outcome.workerId] };
const first = schema.safeParse(outcome.output);                   // validate the typed ARG — no scrape
if (first.success) return { output: first.data, status: "passed", childWorkerIds: [outcome.workerId] };
// retry-once preserved (today step.ts:121-128), re-prompting to re-emit valid output via the tool:
const second = await spawnStep(node, ctx, basePrompt + RETRY_NOTE(first.error));
const retry = asZod(node.outputSchema)!.safeParse(secondOutcome.output);
return retry.success
  ? { output: retry.data, status: "passed", childWorkerIds: [secondOutcome.workerId] }
  : { output: secondOutcome.output, status: "failed", childWorkerIds: [secondOutcome.workerId] };
```

The `compileJsonSchema` validator (`json-schema-validator.ts:33-42`) and its
`attachOutputValidators` wiring (`:47-53`, called at `WorkflowService.ts:82`) are
**reused unchanged** — they now validate the structured tool argument instead of a
value scraped from prose. `extractJson`/`balancedSpan`
(`util.ts:35-45`) becomes dead code for steps (the prose mis-capture risk is gone).
`resolveStrict` for input bindings (`step.ts:86-98`) is unchanged.

### B2.4 Loop / report-hold interaction (preserved)

A looped step's report is HELD until the loop-goal release
(`onReport` held check at `WorkerSpawnAdapter.ts:274`; `reportHoldGate` at
`workers.ts:588`; `decideReportDisposition` at `report-signal.ts:19-35`), and its
intermediate IDLE is exempt (`loopPending` at `WorkerSpawnAdapter.ts:301`). The
output tool must respect the same semantics. Concretely, the `/step-output` route
computes `held` by **mapping `status` → `ReportSignal`** (`done`→`result`,
`failed`→`failed`, `needs-input`→`needs-input`) and reusing
`decideReportDisposition({ signal, loopActive, retryOnFailed })` — the same pure
rule the report path uses — then publishes `held` on the topic; `onStepOutput`
honors `held` exactly as `onReport` does. The loop-release republish path (today
re-emits `worker:report{held:false}`) must be extended to re-emit
`workflow:step-output{held:false}` for a held node-output (the one concrete piece
of loop wiring this change adds — D3).

### B2.5 Fail-closed (the backstop finally bites)

With the last-message path removed (B3), a worker that never calls
`workflow_step_output` no longer settles from prose — it waits and the existing
`stepTimeoutMs` backstop (`WorkerSpawnAdapter.ts:180-189`, wired from
`config.workflow.defaultStepTimeoutMs` at `container.ts:965`) rejects the join,
failing the node loudly. Today that backstop almost never fires because
`onStateChange` settles first off any non-empty last message; removing that path is
what makes the timeout the real fail-closed guarantee.

### B2.6 Optional refinement — per-spawn schema on the tool arg

Because the worker's tool surface is built per spawn (B5), the node's
`outputSchema` can be threaded into the `workflow_step_output` `output` arg's
JSON-Schema at spawn time, so the backend (SDK/CLI) validates the shape at the tool
boundary AND the model sees the exact expected structure — improving first-try
accuracy and reducing the retry. Baseline (B2.3, executor-side validate + one
retry) works without it; this is a quality lever, not a correctness requirement.

## B3. What is DELETED, and back-compat / migration

DELETE (the last-message capture, both halves):

- `container.ts:893-894` — the `finalText … noteAssistantText` feed.
- `WorkerSpawnAdapter.onStateChange` settle (`:295-306`) and, with it, the
  `worker:change` subscription (`:129`), the `lastText` map (`:121`),
  `noteAssistantText` (`:134-137`), and the `lastText.delete` cleanup (`:167`).
  These become dead once steps settle only from the output tool.
- The text-contract prompt strings `STEP_REPORT_INSTRUCTION` and
  `SCHEMA_INSTRUCTION` (`step.ts:18-29`) — the worker is no longer told "your final
  message IS the output"; the workflow-worker DPI prompt (B4) owns the contract
  ("emit via the tool"). The per-step appended schema hint, if kept, moves into the
  output-tool description or the per-spawn arg schema (B2.6).
- For steps: `classifyReport`/`signalStatus` usage and `extractJson` (now dead on
  the step path; both remain for the general report channel).

Back-compat impact and migration:

- **`WorkerSpawnAdapter.test.ts:122-132`** ("settles on turn-end IDLE (no report)
  using the last assistant message as output") encodes the exact removed behavior —
  it DIES and is rewritten around `workflow:step-output`. The resolve-once test
  (`:134-146`) loses its `noteAssistantText` capture line; the looped-step test
  (`:148-162`) is re-cast around step-output held/release.
- **The two builtins** (`manager/workflows/research-analysis-planning.ts`,
  `build-with-experts.ts`) author **typed** steps already
  (`research-analysis-planning.ts:28-58` — `outputSchema: ResearchSchema/…`, code-DSL
  Zod), so under the migration their step workers emit the typed payload via
  `workflow_step_output`; their code-DSL prompts are unchanged. The coupling the
  operator named is real and intentional: **with last-message capture removed, a
  worker with no output tool OR no instruction to call it ALWAYS times out** — so
  B2 (tool) and B4/B5 (prompt + scope) must land together, never separately.
- Any "just answer and end the turn" step authored without a schema now requires
  the worker-node prompt (B4) that instructs the output-tool call. There is no
  silent text fallback by design — that is the fix.

## B4. The workflow-worker DPI role (system prompt)

Today a workflow step worker gets `role=worker` + `isSubagent=true` +
`collaborate:true` (`step.ts:64`) = the **full general-worker fragment set**,
including the parent-report/Handover contract and sub-spawn guidance — exactly the
machinery the operator wants dropped. The fix is a **third DPI role**,
`workflow-worker`, whose prompt is entirely workflow-specific.

The prompt side is clean because DPI is genuinely role-driven and `role` is a
session-IMMUTABLE fact (`core/src/use-cases/AssembleSystemPrompt.ts:6-10`;
`contracts/src/prompt.ts:104-106`). Every general-worker fragment gates on
`{ all: [ {fact: role, eq: worker}, {fact: isSubagent, eq: true} ] }` (confirmed
e.g. `manager/prompts/role/worker/03-hard-rules.prompt.md:8`), and fragment
selection drops non-matching fragments — so a NEW `role` value **automatically
excludes** the entire general-worker set by construction (no `overrides` needed).

### B4.1 Enum + derivation changes

1. Add the value to the three enums:
   - `contracts/src/prompt.ts:90` `SessionFacts.role`:
     `z.enum(["orchestrator","worker","git"])` → add `"workflow-worker"`.
   - `core/src/use-cases/AssembleSystemPrompt.ts:22` `SessionSpawnContext.role`
     union → add `"workflow-worker"`.
   - `contracts/src/http.ts:41` `SpawnWorkerRequest.role`:
     **currently `z.enum(["git"]).optional()`** → `z.enum(["git","workflow-worker"]).optional()`.
     (Note: the often-cited `http.ts:1485` is `PromptPreviewRequestSchema.role`, a
     debug-preview endpoint — NOT the spawn request. The spawn request's role is
     `:41`.)
2. Extend the role-derivation ternary at the single spawn chokepoint
   `manager/container.ts:593`:
   ```ts
   const role = spec.isOrchestrator ? "orchestrator"
              : spec.role === "git" ? "git"
              : spec.role === "workflow-worker" ? "workflow-worker"
              : "worker";
   ```
   Both backend lanes flow through this one `assembleAppendText`
   (`container.ts:592-651`, used by claude-cli via the append file and by claude-sdk
   at `container.ts:790`), so the role is set in exactly one place.
3. Thread `role: "workflow-worker"` from the step spawn: add an optional `role` to
   `SpawnStepSpec` (`WorkerSpawnPort.ts:16-38`), set it in `spawnStep`
   (`step.ts:52-67`), and emit it in `WorkerSpawnAdapter.stepRequest`
   (`:248-266`, which today sets no `role`). `StepSpawnRequest` is a
   `SpawnWorkerRequest` (`WorkerSpawnAdapter.ts:51`), so the `http.ts:41` enum
   widening is what makes `role: "workflow-worker"` type-check.
4. `agentRole` already persists end-to-end: `SpawnWorker.ts:298`
   `agentRole: resolved.role ?? null` writes the `agent_role` column, read back on
   respawn — so the role survives a spawn round-trip with no new plumbing.
5. **`resolveDefinitionName` is unaffected**
   (`core/src/domain/worker-definition-resolution.ts:29-31`:
   `from?.trim() || (role === "git" ? "git" : DEFAULT)`). A `workflow-worker` role
   falls through to `from || DEFAULT`, so the step's `from` still selects the worker
   definition BODY; the role only swaps the DPI fragment set + tool surface. The two
   axes stay orthogonal — exactly right.

### B4.2 New fragment dir `manager/prompts/role/workflow-worker/`

Layer `role`, every fragment gated `{ fact: role, eq: workflow-worker }` (the
general-worker fragments require `role eq worker`, so they exclude automatically).
A genuinely workflow-optimized prompt — drop everything that does not apply:

| Fragment (priority) | Says |
|---|---|
| `01-node-role` (10) | "You are ONE deterministic node in a workflow graph. You receive a typed input, do exactly the node's work, and emit ONE typed output. You are not a conversational agent and have no orchestrator to report to." |
| `02-input-contract` (20) | How typed input bindings arrive (the node's resolved input ports interpolated into the prompt, e.g. `{{in.research}}`); inputs are pre-resolved and trustworthy; missing required input is an upstream failure, not yours to chase. |
| `03-output-contract` (30) | "Finish by calling `workflow_step_output` EXACTLY once: `output` = your result (matching the declared schema if any), `status` = `done` on success, `failed`/`needs-input` (+ one-line `reason`) if you genuinely cannot. Your conversational messages are NOT the output — only the tool call is. If you never call it, the node times out and fails." |
| `04-scope` (40) | "Do only this node's work. Do NOT spawn sub-workers, consult peers, report to a parent, or write a Handover — those do not exist for you. No `result:`/`failed:` first-line convention; status is the tool's `status` field." |

Explicitly ABSENT (vs general worker `manager/prompts/role/worker/`): `02-where-you-sit`
(routes on send_message_to_parent), `03-hard-rules` (one-report-per-directive +
AskUserQuestion ban via `{{SEND_MESSAGE_TO_PARENT_TOOL}}`), `04-collaboration`
(peers), `05-what-you-can-do` (sub-spawn via Task), `08-replying-to-the-operator`,
`09-reporting…` (the `result:`/Handover/send_message_to_parent contract). They drop
automatically.

**Retarget the preamble.** `manager/prompts/system-preamble-worker.prompt.md:6`
gates `{ fact: role, ne: orchestrator }` — which would STILL fire for
workflow-worker. Change it to `{ fact: role, in: ["worker","git"] }` (the `in`/`nin`
operators exist, `contracts/src/prompt.ts:40-41`) and either author a lean
`system-preamble-workflow.prompt.md` gated on the new role or let workflow workers
carry no general preamble (recommended — the preamble is general-agent behavior,
not node behavior).

### B4.3 Immutability — satisfies the DPI rule

`role == "workflow-worker"` is session-IMMUTABLE: a step worker is spawned by the
engine for exactly one node and never transitions to another role; the prompt is
frozen at launch (`AssembleSystemPrompt.ts:4-5`). This satisfies the rule that
`when` may gate ONLY on session-immutable facts
(`AssembleSystemPrompt.ts:6-10`, `prompt.ts:104-106`).

## B5. The tool surface (the friction point)

The prompt keys on the DPI `role` string; the **tool surface keys on a different
axis** — the boolean `isOrchestrator` (+ `collaborate`) at THREE sites, never on
`role`. `ToolDefinition.visibility` (`manager/tools/types.ts:12,29`) is documentary
only — never read for gating (grep-confirmed in the investigation); array
membership is the real gate. So exposing the output tool to workflow workers (and
denying them send_message_to_parent + peers) needs a new array + a third branch
keyed on a plumbed role signal.

1. **New array** in `manager/tools/registry.ts` (beside `orchestratorDefs:23-38`,
   `workerDefs:41`, `peerDefs:45`):
   ```ts
   export const workflowWorkerDefs: ToolDefinition[] = [workflowStepOutputDef, currentDatetimeDef];
   ```
   It does **not** include `sendMessageToParentDef` or the peer defs.
2. **A third branch at all three gate sites**, keyed on the role (plumb the
   already-persisted role/agentRole to each tool host):
   - In-process lane — `container.ts:734`:
     ```ts
     const defs = spec.role === "workflow-worker" ? workflowWorkerDefs
                : spec.isOrchestrator ? orchestratorDefs
                : [...workerDefs, ...(collaborate ? peerDefs : [])];
     ```
   - claude-sdk lane — `manager/backends/sdk/SdkToolHost.ts:52-54`; add `role` to
     `SdkToolHostInput` (`:32-36`, today `{isOrchestrator, collaborate, ctx}`) and
     branch first on `role === "workflow-worker"`.
   - claude-cli MCP subprocess — `manager/worker-mcp.ts:18` (today
     `session.collaborate ? [...workerDefs, ...peerDefs] : workerDefs`); add
     `session.role` (via `worker-mcp/SessionContext.ts`) and branch on it.
3. **`collaborate: false` for the workflow step** (flip `step.ts:64` from `true`)
   so the peer mesh is off regardless of the surface array — belt and suspenders.
   The subtractive `toolScope`/`editRegex`/permission-mode layers
   (`spawn-worker.ts:72-91`) remain available to further fence (e.g. `toolsDeny`
   `Task` to hard-block sub-spawn).

**Finalized consequence (B5.3 / D4) — no peer/expert mesh: DECIDED.** Step workers
today consult the run's expert pool through the SAME peer mesh (`collaborate:true` →
`peerDefs`). Running the workflow worker `collaborate:false` and dropping `peerDefs`
therefore also removes step→expert consultation (the `build-with-experts` builtin's
mechanism). **This is intended and accepted**: a workflow worker is a deterministic
node with NO peer or expert consultation, full stop. NO expert-consult follow-up
tool is added — it is explicitly OUT OF SCOPE. (A narrowly-scoped expert-consult
tool could be reconsidered later only if a concrete need surfaces; not now, and not
a planned item.)

## B6. Settle channel — REPLACE: `workflow_step_output` is the sole channel (DECIDED)

**DECISION: REPLACE.** Workflow workers get ONLY `workflow_step_output` — no
`send_message_to_parent`, no peers. The output tool is the **sole** settle channel;
the node never settles from anything else. `needs-input` is a first-class `status`
that fails the node with its `reason`. One typed contract, no orchestrator-report
surface — matching the operator's "single typed output emitted via the output tool,
drop the general worker's machinery" verbatim. `send_message_to_parent` is removed
from the workflow worker's tool surface (B5.1); `needs-input` and loop hold are
handled as in B2.1/B2.4.

The COEXIST alternative (keep `send_message_to_parent` as a non-settling
side-channel) was **rejected**: it re-introduces the parent-report machinery the
operator wants gone and gives the worker two ways to "finish," muddying the
single-output contract.

Forward note (not now, not planned): IF mid-run human progress is ever needed, the
path is a narrow, explicitly NON-settling `workflow_step_progress` tool in
`workflowWorkerDefs` — never restoring `send_message_to_parent`.

## B7. How Part B fits Part A, and why it ships first

- The output tool emits the node's **typed OUTPUT PORT value** (A5): today's
  `outputSchema` (`workflow-node.ts:197`) validated by `compileJsonSchema`
  (`json-schema-validator.ts:33`) becomes the output-port type, and the tool's
  `output` arg IS that port value — validated as a structured argument, not scraped.
  Part B makes the typed port *structural* instead of best-effort.
- The workflow-worker DPI prompt (B4) is precisely the system prompt for a
  **worker-kind node** in the A2 graph; the role + tool surface are node-kind
  configuration.
- **Crucially, Part B is independently shippable on TODAY's tree engine.** It needs
  no graph, no scheduler, no new contract version — it touches the step executor,
  the spawn adapter, one route, the DPI role, and the tool registry. It fixes the
  false-pass class and makes typed output structural *before* any graph migration,
  and it de-risks A5/Phase 3 (typed ports) by proving the typed-output mechanism on
  the current engine. It therefore slots in as the **first build phase** (Phase 0B
  below), pairing naturally with the determinism/id hardening of Phase 0A.

---

# PART C — UNIFIED PHASED BUILD PATH

Each phase is independently shippable; back-compat is preserved throughout.
Verify every phase per repo convention: `cd contracts && npm test`,
`cd manager && npm test` (engine/adapter/rearm + core + spawner),
`cd app/ui && npm test`, `npm run lint` (dependency direction + guards). **Do NOT
`eos build` / `eos restart`** (it restarts the daemon and crashes every running
worker — `CLAUDE.md`).

### Phase 0A — Harden determinism + ids on the current tree
- Make glob fan-in deterministic: sort matched ids in a stable order in
  `resolveNodes` (`bindings.ts:81-88`); add the missing fan-in determinism test.
- Enforce node-id uniqueness at run acceptance: a `collectIds`
  (`node-scope.ts:29`) duplicate check in `WorkflowService.run`
  (`WorkflowService.ts:67`), failing loud.
- Verify: contracts + manager tests, lint. *Independently shippable; de-risks A3.4.*

### Phase 0B — Typed worker-execution contract (PART B) — ships first, on today's engine
- New `workflow_step_output` tool + `workflowWorkerDefs` array (B2, B5.1);
  new `StepOutputRequestSchema` + `POST /workers/:id/step-output` route +
  `workflow:step-output` bus topic (B2.2).
- `StepOutcome` → `{ workerId, status, output, reason? }`
  (`WorkerSpawnPort.ts:43-47`); `WorkerSpawnAdapter.onStepOutput`; DELETE the
  last-message path (`container.ts:893-894`, `WorkerSpawnAdapter.onStateChange`
  `:295-306` + the `lastText`/`noteAssistantText`/`worker:change` plumbing) (B3).
- `step.ts` executor rewrite (B2.3): output from the tool arg, schema validates the
  arg, retry-once preserved; drop `STEP_REPORT_INSTRUCTION`/`SCHEMA_INSTRUCTION`.
- Loop hold for the new channel + release republish (B2.4).
- New DPI role `workflow-worker`: enums + derivation (B4.1), fragment dir +
  preamble retarget (B4.2); tool surface = `workflowWorkerDefs` ONLY via a
  role-keyed branch at the three hosts — `send_message_to_parent` + peers removed
  (final, B6/D1), `collaborate:false` with no peer/expert mesh (final, B5.3/D4).
- Verify: rewrite `WorkerSpawnAdapter.test.ts:122-162` around the output tool; a
  step-executor test asserting a non-`done` status fails the node and a missing
  tool call hits the timeout; the two builtins
  (`research-analysis-planning`/`build-with-experts`) stay green through the new
  channel; manager + contracts tests, lint.

### Phase 1 — v2 graph contract + tree→graph compiler (dormant; no runtime change)
- New `contracts/src/workflow-graph.ts` (A2). Make `WorkflowDefinition`
  (`workflow.ts:30-37`) a `version`-discriminated union of v1 tree + v2 graph.
- New pure `core/src/workflow/tree-to-graph.ts`: topo of the nested tree
  (`childrenOf`, `node-scope.ts:52-68`) into flat nodes+edges; container nesting →
  structural edges; `{{nodes.id.output}}` → explicit edges; ordered glob fan-in →
  `merge` edges; root → `output` node.
- Golden test: the two builtins compile faithfully.
- Verify: new core suite + contracts schema test + lint. *Pure additive
  contract+compiler; nothing executes the graph yet.*

### Phase 2 — Readiness scheduler becomes the runtime (tree compiles into it)
- New `core/src/workflow/scheduler.ts` (A3.1) reusing `runNode`, `BindingScope`,
  `CountingSemaphore`, journal.
- `engine.ts:159`: swap `runNode(def.root)` → `scheduleGraph(graph)`, where `graph`
  is the v2 graph directly or `treeToGraph(def)` for v1 — **one runtime, both
  shapes**.
- New executors `input`/`output`/`branch`/`merge`/`loop`
  (`register-builtins.ts:33` pattern); generalize `scopeNodeIds`/`collectIds`
  (`node-scope.ts:24-33`) to `loop` sub-graphs.
- Verify: the EXISTING engine/adapter/rearm tests + the two builtins stay green
  (the back-compat regression gate); new scheduler tests (readiness order, fan-in
  determinism, branch skip, loop scoping, partial-graph resume); manager test, lint.

### Phase 3 — Typed edges + port types (builds on Phase 0B)
- Promote `outputSchema` (`workflow-node.ts:197`) to output-port type; reuse
  `compileJsonSchema` (`json-schema-validator.ts:33`) at the port boundary — the
  SAME validator Part B already applies to the `workflow_step_output` arg; input
  ports declare expected types; the scheduler validates at the node boundary; the
  editor type-checks edges at authoring time.
- Verify: contracts + manager tests; a port-type-mismatch test.

### Phase 4 — Orchestrator-free authoring/launch
- CLI `manager/cli/commands/workflow.ts` (run/validate/list/status/stop) +
  register in `registry.ts:21-40` (A6.3).
- HTTP operator-owned run mode in `routes/workflows.ts` (A6.4): owner optional →
  synthetic operator owner; skip agent-inbox completion when the owner isn't a live
  agent; result via `GET /workflows/:id` + SSE.
- `FileWorkflowDefinitionSource.ts` accepts v2 graph docs (A6.1).
- Verify: routes test, CLI smoke, manager test. *Zero-LLM launch is live.*

### Phase 5 — Node-editor UI
- Replace `WorkflowsEmpty` (`WorkflowsView.jsx:26`) with the canvas (A6.2): palette
  from the live capability catalog (`container.ts:980`), inspector, typed edges,
  Save(PUT)/Run(POST), live SSE highlighting (`workflow:run-change` /
  `workflow:step-change`).
- Verify: `cd app/ui && npm test` + `npm run build`.

### Phase 6 — Reframe + (optional) retire string-binding
- Reframe `17-workflows.prompt.md` so workflows are a standalone graph engine; the
  orchestrator is one optional caller (A6.5).
- Optionally retire raw cross-node `{{nodes.*}}` wiring once no tree definitions
  remain (keep intra-node prompt interpolation).
- Verify: lint + manager test.

**Shippability summary.** Phase 0A hardens today's system; **Phase 0B ships the
typed worker-execution contract on the current tree engine** (the operator's
requested fix, no graph required). Phase 1 adds a dormant contract+compiler. Phase
2 flips the runtime to graph while every existing tree still runs. Phases 3–6 layer
typed ports (reusing Phase 0B's validator), the zero-LLM launch, the editor, and
the reframe.

---

# PART D — DECISIONS & APPENDIX

### Resolved decisions (locked)

**D1. Settle channel — REPLACE (B6). LOCKED.** Workflow workers use
`workflow_step_output` as the SOLE settle channel; `send_message_to_parent` and
peers are removed from their tool surface (B5.1); the node never settles from
anything but the output tool; `needs-input` stays a first-class status. COEXIST
rejected.

**D4. No peer/expert mesh — DROP (B5.3). LOCKED.** Workflow workers run
`collaborate:false` with no peer or expert consultation. The resulting loss of
step→expert consultation is intended and accepted; NO expert-consult follow-up tool
is added (explicitly out of scope — reconsiderable only if a concrete need surfaces
later, and not a planned item).

### Still-open / forward items

**D2. `needs-input` semantics.** Baseline: maps to a `failed` node with the
`reason` surfaced (fail-closed) — there is no node-level pause primitive today
(`signalStatus` already collapses `needs-input`→failed at `step.ts:48`). A future
`paused` run status + human-input-gated resume (the engine already has resume;
`engine.ts:111-125`) could make a node genuinely block — larger feature, deferred.

**D3. Loop release for the new channel.** The held-output release path must re-emit
`workflow:step-output{held:false}` on the loop-goal release, mirroring the existing
`worker:report` re-emit (B2.4). The one concrete loop-wiring task in Phase 0B;
covered by re-casting the looped-step adapter test (`WorkerSpawnAdapter.test.ts:148-162`).

**D5. String-binding rip-out (A5).** Keep for intra-node prompt interpolation + the
legacy compile path; retire only from new graph authoring. Full removal waits until
no tree definitions remain on disk.

### Citation index (current source verified for this design)

- Engine spine: `core/src/workflow/engine.ts` — `runNode` `:65-96`, memo `:68-74`,
  dispatch `:84`, bind output `:86`, semaphore `:152`, **tree-root dispatch `:159`**,
  result roll-up `:160-162`, PK `:175-177`.
- Data model: `contracts/src/workflow.ts:35` (`root`); `contracts/src/workflow-node.ts:311-330`
  (union), `:334-351` (16 types), `:197` (`outputSchema`);
  `core/src/workflow/node-scope.ts:52-68` (`childrenOf`), `:24-27` (`scopeNodeIds`),
  `:29` (`collectIds`), `:39` (`forEachNode`), `:47` (`containsNodeType`).
- Bindings/predicate: `bindings.ts:44-46`/`:54-63`/`:77-91`/`:81-88`;
  `predicate.ts:11-32`.
- Determinism guard: `core/src/__tests__/workflow-determinism-guard.test.ts:25-35`.
- Registry: `core/src/workflow/register-builtins.ts:28-33`.
- Worker-execution (Part B): `core/src/workflow/executors/step.ts`
  (STEP/SCHEMA instructions `:18-29`, `signalStatus` `:47-49`, spawnStep + `collaborate:true`
  `:51-68`, validate/extract `:72-80`, no-schema/schema branches `:101-131`);
  `core/src/ports/WorkerSpawnPort.ts:16-38` (`SpawnStepSpec`), `:43-47` (`StepOutcome`);
  `core/src/domain/report-signal.ts:9-15` (`classifyReport`), `:19-35`
  (`decideReportDisposition`);
  `manager/services/WorkerSpawnAdapter.ts` (settle header `:9-33`, `noteAssistantText`
  `:134-137`, timeout `:180-189`, `stepRequest` `:248-266`, `onReport` `:268-278`,
  `onExit` `:280-289`, `onStateChange` `:295-306`);
  `manager/container.ts:593` (role derivation), `:592-651`/`:790` (DPI chokepoint),
  `:734` (in-process tool gate), `:888-894` (last-message feed), `:965`
  (`stepTimeoutMs`), `:980` (capability catalog);
  `manager/routes/workers.ts:577-656` (report route — publish `:592`, hold `:588`,
  dispatch/auto-apply `:600-655`);
  `manager/tools/defs/send_message_to_parent.ts:4-17`; `manager/tools/registry.ts:23-45`;
  `manager/tools/types.ts:12,29` (inert `visibility`);
  `manager/services/json-schema-validator.ts:33-42`/`:47-53`;
  `manager/services/WorkflowService.ts:67-106` (attach `:82`, trust gate `:73-77`);
  `core/src/workflow/executors/util.ts:35-45` (`extractJson`);
  `manager/services/__tests__/WorkerSpawnAdapter.test.ts:122-162` (tests to rewrite).
- Role/prompt/tool surface: `contracts/src/prompt.ts:30-44` (conditions), `:57`
  (layers), `:88-90` (role enum), `:104-106` (immutability);
  `core/src/use-cases/AssembleSystemPrompt.ts:6-10`/`:22`/`:58-99`;
  `core/src/services/fragment-select.ts` (include-if-`when`);
  `manager/prompts/role/worker/*` (`03-hard-rules.prompt.md:8` gate),
  `manager/prompts/system-preamble-worker.prompt.md:6` (preamble gate);
  `contracts/src/http.ts:41` (**spawn `SpawnWorkerRequest.role` — `z.enum(["git"])`**;
  not `:1485`, which is `PromptPreviewRequestSchema`);
  `core/src/use-cases/SpawnWorker.ts:298` (`agentRole` persist);
  `core/src/domain/worker-definition-resolution.ts:29-31` (`resolveDefinitionName`);
  `manager/commands/handlers/spawn-worker.ts:46`/`:92-131`;
  `manager/backends/sdk/SdkToolHost.ts:32-36`/`:52-54`; `manager/worker-mcp.ts:18`.
- Authoring/launch: `manager/tools/defs/workflow.ts:60`,`:62`;
  `manager/routes/workflows.ts:31-45`,`:60`,`:69-73`,`:7` (SSE);
  `app/ui/src/views/workflows/WorkflowsEmpty.jsx:12`, `WorkflowsView.jsx:26`;
  `infra/src/workflow/FileWorkflowDefinitionSource.ts`;
  `manager/cli/commands/registry.ts:21-40`.
