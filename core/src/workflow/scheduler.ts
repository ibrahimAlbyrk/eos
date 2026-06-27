// scheduler.ts — the readiness-driven graph scheduler (design A3/A4 Option C). It
// is the SINGLE workflow runtime: `engine.execute` compiles a v1 tree into a v2
// graph (treeToGraph) or takes a v2 graph directly, then hands it here. A node
// becomes READY when every incoming edge has resolved (a value or a `skipped`
// token); ready nodes fire in graph-declaration order (Kahn's algorithm); a node's
// output resolves its outgoing edges; the run result is the OUTPUT node's value.
//
// What it REUSES verbatim: `runNode` (the Template Method — journal/memo/progress
// per node) for every leaf/data node, by reconstructing the v1 WorkflowNode from
// the graph node's kind+config and dispatching through the engine; the per-run
// CountingSemaphore at the leaf choke point (reached via runNode → stepExecutor →
// ctx.concurrency); BindingScope (the run value store — every node self-binds its
// output under its id, so `{{nodes.<id>.output}}` and the fan-out glob resolve
// exactly as before); Clock/IdGenerator determinism (this file lives under
// core/src/workflow/, in the guard's scope — no Date.now/Math.random).
//
// What it ADDS (graph-native, no v1 executor): input/output framing, deterministic
// fan-in at `merge` nodes (edge-declaration order), `branch` skip-propagation (one
// outgoing port activated, the other drained as `skipped`), and encapsulated `loop`
// nodes that re-schedule their body sub-graph per iteration. Failure short-circuits
// downstream exactly as the v1 sequence did: a failed node propagates a failed
// token, a node whose required inputs are all failed/skipped does not run.

import type { WorkflowGraph, GraphNode, GraphEdge, NodePort } from "../../../contracts/src/workflow-graph.ts";
import type { WorkflowNode } from "../../../contracts/src/workflow-node.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";
import type { NodeResult, WorkflowExecCtx } from "../ports/StepExecutor.ts";
import { isWorkflowGraph } from "../../../contracts/src/workflow-graph.ts";
import { BindingScope } from "./bindings.ts";
import { evaluate } from "./predicate.ts";
import { treeToGraph } from "./tree-to-graph.ts";
import { scopeGraphNodeIds } from "./node-scope.ts";
import { resolveList, execLocals, errMessage, kindOf } from "./executors/util.ts";

// The internal completion record for a node (a superset of NodeResult — a branch
// also records which outgoing port it activated, the one piece of state edge
// resolution needs that a NodeResult cannot carry).
interface Outcome {
  status: "passed" | "failed" | "skipped";
  output: unknown;
  activePort?: string; // branch only
}

// A `skipped` edge carries no value; any other edge carries the source's value +
// terminal status. `tokenOf` derives this from the source outcome + the edge port.
const SKIPPED = Symbol("skipped");
type EdgeToken = typeof SKIPPED | { value: unknown; status: "passed" | "failed" };

// Lower whatever the engine was handed into the one runtime shape: a v2 graph runs
// directly; a v1 tree is compiled once at run start (A4 — exactly one execution
// path). Exported so the engine's dispatch swap is a one-liner.
export function toGraph(def: WorkflowDefinition | WorkflowGraph): WorkflowGraph {
  return isWorkflowGraph(def) ? def : treeToGraph(def);
}

export function scheduleGraph(graph: WorkflowGraph, ctx: WorkflowExecCtx): Promise<NodeResult> {
  return new GraphRun(graph, ctx).run();
}

class GraphRun {
  private readonly graph: WorkflowGraph;
  private readonly ctx: WorkflowExecCtx;
  private readonly byId = new Map<string, GraphNode>();
  private readonly index = new Map<string, number>();      // node id → declaration order
  private readonly inEdges = new Map<string, GraphEdge[]>();
  private readonly outEdges = new Map<string, GraphEdge[]>();
  private readonly pendingIn = new Map<string, number>();  // incoming edges whose source has not completed
  private readonly outcomes = new Map<string, Outcome>();
  private readonly fanInCache = new Map<string, boolean>();  // node id → reaches an array merge
  private readonly started = new Set<string>();
  private readonly ready: string[] = [];
  private active = 0;
  private settled = false;
  private resolveRun!: (_r: NodeResult) => void;
  private rejectRun!: (_e: unknown) => void;

  constructor(graph: WorkflowGraph, ctx: WorkflowExecCtx) {
    this.graph = graph;
    this.ctx = ctx;
    graph.nodes.forEach((n, i) => {
      this.byId.set(n.id, n);
      this.index.set(n.id, i);
      this.inEdges.set(n.id, []);
      this.outEdges.set(n.id, []);
      this.pendingIn.set(n.id, 0);
    });
    for (const e of graph.edges) {
      // Drop self-edges defensively. treeToGraph no longer emits one, but a
      // hand-authored v2 graph may (the schema does not reject self-edges until
      // Phase 4). A node can never gate readiness on its own output — the
      // `loopUntil` self-reference (`{{nodes.<loop>.lastCount}}`) flows via
      // BindingScope each round, never an edge — so a self-edge is always spurious
      // and would deadlock the frontier.
      if (e.from.node === e.to.node) continue;
      this.outEdges.get(e.from.node)?.push(e);
      this.inEdges.get(e.to.node)?.push(e);
      this.pendingIn.set(e.to.node, (this.pendingIn.get(e.to.node) ?? 0) + 1);
    }
  }

  run(): Promise<NodeResult> {
    return new Promise<NodeResult>((resolve, reject) => {
      this.resolveRun = resolve;
      this.rejectRun = reject;
      for (const n of this.graph.nodes) {
        if ((this.pendingIn.get(n.id) ?? 0) === 0) this.ready.push(n.id);
      }
      this.pump();
    });
  }

  // Dispatch every currently-ready node in graph-declaration order. Ready nodes
  // accumulate as their last incoming edge resolves; sorting by declaration index
  // makes the fire order (hence the spawn order) reproducible regardless of which
  // sibling completed first.
  private pump(): void {
    if (this.settled) return;
    this.ready.sort((a, b) => (this.index.get(a) ?? 0) - (this.index.get(b) ?? 0));
    while (this.ready.length > 0) {
      const id = this.ready.shift()!;
      if (this.started.has(id)) continue;
      this.started.add(id);
      this.active += 1;
      this.dispatch(id).then(
        (outcome) => this.onComplete(id, outcome),
        (err) => this.fail(err),
      );
    }
    this.maybeFinish();
  }

  private onComplete(id: string, outcome: Outcome): void {
    if (this.settled) return;
    this.active -= 1;
    this.outcomes.set(id, outcome);
    // Self-bind every node's output under its id so `{{nodes.<id>.output}}` and the
    // fan-out glob resolve from BindingScope (leaf nodes already self-bound inside
    // runNode; this covers the graph-native control nodes). Skipped ⇒ no binding.
    if (outcome.status !== "skipped" && !isLeafKind(this.byId.get(id)!.kind)) {
      this.ctx.bindings.set(id, outcome.output);
    }
    for (const e of this.outEdges.get(id) ?? []) {
      const left = (this.pendingIn.get(e.to.node) ?? 0) - 1;
      this.pendingIn.set(e.to.node, left);
      if (left === 0) this.ready.push(e.to.node);
    }
    this.pump();
  }

  private fail(err: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectRun(err);
  }

  private maybeFinish(): void {
    if (this.settled || this.active > 0 || this.ready.length > 0) return;
    this.settled = true;
    this.resolveRun(this.runResult());
  }

  // Roll up EVERY output node (the schema permits ≥1): the run fails if any output
  // failed, is skipped only when all skipped, else passed. A single-output graph
  // (every lowered tree) resolves to that one output's value unchanged; a
  // multi-output graph carries the per-output values in node-declaration order.
  private runResult(): NodeResult {
    const outcomes = this.graph.nodes
      .filter((n) => n.kind === "output")
      .map((n) => this.outcomes.get(n.id) ?? { status: "failed" as const, output: undefined });
    if (outcomes.length <= 1) {
      const only = outcomes[0] ?? { status: "failed" as const, output: undefined };
      return { output: only.output, status: only.status };
    }
    const status: NodeResult["status"] = outcomes.some((o) => o.status === "failed")
      ? "failed"
      : outcomes.every((o) => o.status === "skipped")
        ? "skipped"
        : "passed";
    return { output: outcomes.map((o) => o.output), status };
  }

  // ---- per-node dispatch ----------------------------------------------------
  private async dispatch(id: string): Promise<Outcome> {
    const node = this.byId.get(id)!;
    const tokens = (this.inEdges.get(id) ?? []).map((e) => this.tokenOf(e));

    if (node.kind === "input") return { status: "passed", output: this.ctx.args };
    if (node.kind === "merge") return this.runMerge(node, tokens);
    if (node.kind === "output") return outputOutcome(tokens);

    // Every other kind respects failure short-circuit + skip-propagation, matching
    // the v1 sequence (a failed upstream stops the chain) and conditional (an
    // unreached arm is skipped, not run).
    const failed = tokens.find((t): t is { value: unknown; status: "failed" } => t !== SKIPPED && t.status === "failed");
    if (failed) return { status: "failed", output: failed.value };
    if (tokens.length > 0 && tokens.every((t) => t === SKIPPED)) return { status: "skipped", output: undefined };

    if (node.kind === "branch") return this.runBranch(node);
    if (node.kind === "loop") return this.runLoop(node);
    if (node.kind === "subGraph") return this.runSubGraph(node);
    return this.runLeaf(node);
  }

  // A leaf/data node (worker/script/glue) is reconstructed into its v1 WorkflowNode
  // and driven through the UNCHANGED runNode Template Method — so journaling, memo
  // replay, progress, the concurrency gate, and the binding write all happen there,
  // verbatim. A throw fails-soft to a degraded result ONLY when the node sits within
  // a fan-in (array-merge) region (the v1 parallel/forEach catch); otherwise it
  // propagates and aborts the run (the v1 sequence/root behaviour — and how a user
  // stop surfaces).
  private async runLeaf(node: GraphNode): Promise<Outcome> {
    // Resolve incoming edges → typed input ports (A5). bindIncomingData mirrors them
    // into BindingScope (legacy string-ref compat) AND returns the map; the typed map
    // is what the executor consumes via ctx.inputs (worker spec / `{{in.<port>}}`).
    const inputs = this.bindIncomingData(node);
    const v1 = reconstructNode(node);
    const typeError = validatePortInputs(node, inputs);
    if (typeError) {
      // D4: validation fails BEFORE runNode would create the journal row, so the
      // failed node would otherwise leave NO workflow_steps row. Record a terminal
      // `failed` row (carrying the validation error) through the engine so the
      // failed node is visible in the journal + to resume. The failed Outcome still
      // propagates downstream exactly as before — run-level rollup is unchanged.
      this.ctx.engine.journalFailedNode(v1, this.ctx, typeError);
      return { status: "failed", output: typeError };
    }
    return this.withLabel(node, async () => {
      try {
        return await this.ctx.engine.runNode(v1, { ...this.ctx, inputs });
      } catch (e) {
        if (this.feedsFanIn(node)) return { status: "failed", output: { error: errMessage(e) } };
        throw e;
      }
    });
  }

  private runBranch(node: GraphNode): Outcome {
    this.bindIncomingData(node);
    const predicate = (node.config as { predicate?: Parameters<typeof evaluate>[0] }).predicate;
    const taken = predicate ? evaluate(predicate, this.ctx.bindings) : true;
    return { status: "passed", output: undefined, activePort: taken ? "then" : "else" };
  }

  // ---- merge — deterministic fan-in (A3.4) ----------------------------------
  // An `array` merge (a lowered `parallel`/`forEach`/glob fan-in) aggregates every
  // non-skipped incoming value in EDGE-DECLARATION order; a status of `failed` if
  // any contributor failed. An `any` merge (a lowered `conditional` re-convergence)
  // selects the FIRST non-skipped value in edge order, or `skipped` if all arms were.
  private runMerge(node: GraphNode, tokens: EdgeToken[]): Outcome {
    if (node.outputs?.[0]?.type === "array") {
      const live = tokens.filter((t): t is { value: unknown; status: "passed" | "failed" } => t !== SKIPPED);
      const status = live.some((t) => t.status === "failed") ? "failed" : "passed";
      return { status, output: live.map((t) => t.value) };
    }
    const first = tokens.find((t) => t !== SKIPPED);
    if (!first || first === SKIPPED) return { status: "skipped", output: undefined };
    return { status: first.status, output: first.value };
  }

  // ---- subGraph — run a resolved definition as a scoped sub-run --------------
  private async runSubGraph(node: GraphNode): Promise<Outcome> {
    const cfg = node.config as { name: string; args?: unknown };
    if (!this.ctx.resolveDefinition) throw new Error(`subWorkflow "${node.id}" requires a definition resolver`);
    const def = this.ctx.resolveDefinition(cfg.name);
    if (!def) throw new Error(`subWorkflow definition "${cfg.name}" not found`);
    const scoped = scopeGraphNodeIds(toGraph(def), `@${node.id}`);
    const childCtx: WorkflowExecCtx = {
      ...this.ctx,
      bindings: new BindingScope(cfg.args ?? this.ctx.args),
      item: undefined,
      index: undefined,
    };
    return this.withLabel(node, () => scheduleGraph(scoped, childCtx));
  }

  // ---- loop — re-schedule the encapsulated body sub-graph per iteration ------
  private runLoop(node: GraphNode): Promise<Outcome> {
    const cfg = node.config as {
      loopKind: "forEach" | "pipeline" | "loopUntil";
      over?: string; until?: Parameters<typeof evaluate>[0]; maxIterations?: number; body: WorkflowGraph;
    };
    this.bindIncomingData(node);
    return this.withLabel(node, () =>
      cfg.loopKind === "loopUntil" ? this.runLoopUntil(node, cfg) : this.runForEach(node, cfg),
    );
  }

  // forEach + pipeline: one independent body run per runtime item (the leaf gate
  // bounds true concurrency); per-item ids scoped so journal rows never collide.
  private async runForEach(
    node: GraphNode,
    cfg: { over?: string; body: WorkflowGraph },
  ): Promise<Outcome> {
    const items = resolveList(this.ctx, cfg.over ?? "");
    const results = await Promise.all(items.map((item, i) => {
      const scoped = scopeGraphNodeIds(cfg.body, `#${i}`);
      const childCtx: WorkflowExecCtx = { ...this.ctx, item, index: i };
      return scheduleGraph(scoped, childCtx).catch((e): NodeResult => ({ output: { error: errMessage(e) }, status: "failed" }));
    }));
    const status = results.some((r) => r.status === "failed") ? "failed" : "passed";
    return { status, output: results.map((r) => r.output) };
  }

  // loopUntil: re-run the body until the predicate holds or maxIterations is hit;
  // expose {iteration,last,lastCount} under the loop id so the predicate can read
  // `{{nodes.<id>.lastCount}}` (the engine overwrites it with the final output).
  private async runLoopUntil(
    node: GraphNode,
    cfg: { until?: Parameters<typeof evaluate>[0]; maxIterations?: number; body: WorkflowGraph },
  ): Promise<Outcome> {
    if (!cfg.until && cfg.maxIterations == null) {
      throw new Error(`loopUntil "${node.id}" requires 'until' or 'maxIterations'`);
    }
    let lastResult: unknown;
    let lastCount: number | undefined;
    let last: NodeResult = { output: undefined, status: "passed" };
    let iteration = 0;
    while (cfg.maxIterations == null || iteration < cfg.maxIterations) {
      const scoped = scopeGraphNodeIds(cfg.body, `#${iteration}`);
      const childCtx: WorkflowExecCtx = { ...this.ctx, iteration, lastResult, lastCount };
      last = await scheduleGraph(scoped, childCtx);
      lastResult = last.output;
      lastCount = Array.isArray(lastResult) ? lastResult.length : undefined;
      iteration += 1;
      this.ctx.bindings.set(node.id, { iteration, last: lastResult, lastCount });
      if (last.status === "failed") break;
      if (cfg.until && evaluate(cfg.until, this.ctx.bindings)) break;
    }
    return { status: last.status, output: lastResult };
  }

  // ---- edge / data helpers --------------------------------------------------
  private tokenOf(edge: GraphEdge): EdgeToken {
    const src = this.outcomes.get(edge.from.node);
    if (!src || src.status === "skipped") return SKIPPED;
    if (src.activePort !== undefined) {
      return edge.from.port === src.activePort ? { value: undefined, status: "passed" } : SKIPPED;
    }
    return { value: src.output, status: src.status };
  }

  // Resolve a node's incoming DATA edges into its typed input-port values (A5): each
  // live edge delivers its source output-port value to the named `to` port. Edges to
  // the structural `in` port, glob ports (resolved by pattern match, which would
  // self-match a literal key), and edges from the `input` node (args / loop locals /
  // forwarded externals reach the executor via BindingScope args + injected locals)
  // carry no named cross-node data and are skipped — leaving the `in.<port>` namespace
  // for genuine edge-delivered data only.
  private resolveInputs(node: GraphNode): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    for (const e of this.inEdges.get(node.id) ?? []) {
      if (e.to.port === "in" || e.to.port.includes("*")) continue;
      if (this.byId.get(e.from.node)?.kind === "input") continue;
      const token = this.tokenOf(e);
      if (token === SKIPPED) continue;
      inputs[e.to.port] = token.value;
    }
    return inputs;
  }

  // Mirror each resolved input value into BindingScope under the port name, so a
  // `{{nodes.<id>.output}}` ref to a CONTAINER id (a lowered sequence/conditional
  // whose anchor is some other node) still resolves — the one binding real-node
  // self-binds don't already cover (the legacy string-ref role, A5 role b). Returns
  // the same typed map so a leaf can hand it to its executor as ctx.inputs.
  private bindIncomingData(node: GraphNode): Record<string, unknown> {
    const inputs = this.resolveInputs(node);
    for (const [port, value] of Object.entries(inputs)) this.ctx.bindings.set(port, value);
    return inputs;
  }

  // A node soft-fails (rather than aborting the run) when its throw would be
  // aggregated by a fan-in: it can reach an `array` merge (a lowered parallel / glob
  // fan-in) by following out-edges. TRANSITIVELY — so a throw in an interior node of
  // a COMPOSITE parallel branch (e.g. a `sequence` child whose anchor, not the node
  // itself, feeds the merge) still fails-soft to a failed token instead of rejecting
  // the whole GraphRun. A node with no path to an array merge (a root/sequence step,
  // a conditional arm re-converging through an `any` merge → output) keeps the v1
  // propagate-and-abort behaviour. Memoised — the top graph is acyclic.
  private feedsFanIn(node: GraphNode): boolean {
    return this.reachesArrayMerge(node.id, new Set());
  }

  private reachesArrayMerge(id: string, seen: Set<string>): boolean {
    const cached = this.fanInCache.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return false;   // cycle guard — self-edges are already dropped
    seen.add(id);
    let result = false;
    for (const e of this.outEdges.get(id) ?? []) {
      const t = this.byId.get(e.to.node);
      if (!t) continue;
      if (t.kind === "merge" && t.outputs?.[0]?.type === "array") { result = true; break; }
      if (this.reachesArrayMerge(t.id, seen)) { result = true; break; }
    }
    this.fanInCache.set(id, result);
    return result;
  }

  // A graph node may carry a `label` (a lowered `phase`'s human name lands on its
  // body node). Mirror the v1 phaseExecutor: announce the label running → terminal
  // around the node's own work, so the progress stream still shows the grouping.
  private async withLabel(node: GraphNode, work: () => Promise<Outcome | NodeResult>): Promise<Outcome> {
    if (node.label === undefined) return work() as Promise<Outcome>;
    this.ctx.progress.stepChanged(this.ctx.runId, node.label, "running");
    const result = await work();
    this.ctx.progress.stepChanged(this.ctx.runId, node.label, result.status === "failed" ? "failed" : "passed");
    return result as Outcome;
  }
}

// The run output frames every non-skipped feeder with the array-merge roll-up rule:
// FAIL if any feeder failed (a later failed feeder is never swallowed by an earlier
// passed one), carry the first passed value when none failed, and skip only when
// every feeder skipped.
function outputOutcome(tokens: EdgeToken[]): Outcome {
  const live = tokens.filter((t): t is { value: unknown; status: "passed" | "failed" } => t !== SKIPPED);
  if (live.length === 0) return { status: "skipped", output: undefined };
  const failed = live.find((t) => t.status === "failed");
  if (failed) return { status: "failed", output: failed.value };
  return { status: "passed", output: live[0].value };
}

// The graph kinds that map onto an existing v1 leaf executor (driven through the
// unchanged runNode); the rest (input/output/branch/merge/loop/subGraph) are the
// graph-native control kinds the scheduler handles itself.
const LEAF_KINDS = new Set(["worker", "script", "transform", "map", "filter", "dedup", "tally", "accumulate"]);
function isLeafKind(kind: string): boolean {
  return LEAF_KINDS.has(kind);
}

// ---- runtime port-type validation (Phase 3 / A5) ---------------------------
// Validate each delivered input value against its declared, typed input port. The
// node FAILS with a precise error on the first mismatch — the runtime counterpart of
// the authoring-time edge type-compat check, mirroring the Phase-0B output-arg
// discipline but on the INPUT side. There is no retry here (unlike the worker's own
// output): the value is delivered by an upstream edge, so re-running this node cannot
// change it. `any`/undeclared ports and absent values skip; a `json` port defers to a
// manager-attached compileJsonSchema validator when one is present, else requires a
// plain object (json is a typed object).
function validatePortInputs(node: GraphNode, inputs: Record<string, unknown>): string | null {
  for (const port of node.inputs ?? []) {
    const value = inputs[port.name];
    if (value === undefined) continue; // absent input — `required` is a separate (deferred) concern
    const problem = checkPortValue(port, value);
    if (problem) return `node "${node.id}" input port "${port.name}" ${problem}`;
  }
  return null;
}

interface SafeParser { safeParse(_v: unknown): { success: boolean; error?: unknown } }
function asSafeParser(schema: unknown): SafeParser | null {
  return schema && typeof (schema as SafeParser).safeParse === "function" ? (schema as SafeParser) : null;
}

function checkPortValue(port: NodePort, value: unknown): string | null {
  switch (port.type) {
    case "json": {
      const validator = asSafeParser(port.schema);
      if (validator) {
        const r = validator.safeParse(value);
        return r.success ? null : `failed schema validation (${errMessage(r.error)})`;
      }
      return isObject(value) ? null : `expected json object, got ${kindOf(value)}`;
    }
    case "object": return isObject(value) ? null : `expected object, got ${kindOf(value)}`;
    case "array": return Array.isArray(value) ? null : `expected array, got ${kindOf(value)}`;
    case "string": return typeof value === "string" ? null : `expected string, got ${kindOf(value)}`;
    case "number": return typeof value === "number" && Number.isFinite(value) ? null : `expected number, got ${kindOf(value)}`;
    case "boolean": return typeof value === "boolean" ? null : `expected boolean, got ${kindOf(value)}`;
    default: return null; // "any" / undeclared → no constraint
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Reconstruct the v1 WorkflowNode a leaf graph node was lowered from (treeToGraph
// preserved every field in `config`), so the existing executor + runNode consume it
// unchanged. `worker` ⇒ `step` (the only kind whose name differs); every other leaf
// kind shares its v1 type name.
function reconstructNode(node: GraphNode): WorkflowNode {
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const type = node.kind === "worker" ? "step" : node.kind;
  return { ...cfg, type, id: node.id } as unknown as WorkflowNode;
}
