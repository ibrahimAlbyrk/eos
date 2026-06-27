// tree-to-graph.ts — the back-compat compiler (design A4 / Phase 1). Lowers any v1
// WorkflowDefinition (a single-rooted tree, contracts/src/workflow-node.ts) into an
// equivalent v2 node graph (contracts/src/workflow-graph.ts): a flat nodes[] +
// edges[] DAG with first-class input/output nodes, so the future readiness
// scheduler (Phase 2) has exactly ONE execution shape to run.
//
// DORMANT: nothing calls this on the run path yet. It exists so the engine swap in
// Phase 2 can lower legacy trees on load; here it is only exercised by tests.
//
// Pure + deterministic (it lives under core/src/workflow/, the determinism guard's
// scope): no Clock, no Date.now/Math.random. Ids derive from the source ids;
// glob fan-in matches are sorted; children are walked in array order.
//
// Mapping (v1 container/leaf → graph structure):
//   step                      → worker node
//   script                    → script node
//   transform/map/filter/dedup/tally/accumulate → same-named glue node
//   subWorkflow               → subGraph node
//   conditional               → branch node + a `merge` re-convergence node
//   forEach/pipeline/loopUntil → a single `loop` node whose config.body is the
//                                body compiled as a nested sub-graph
//   sequence                  → ordering EDGES between consecutive children
//   parallel                  → fan-out edges + a `merge` fan-in node (the
//                                parallel's id), aggregating children in order
//   phase                     → pass-through (its label lands on the body anchor)
// Data flow: a v1 {{nodes.id.output}} / {{args.*}} ref becomes an explicit edge
// from the referenced node's output anchor to a named input port on the consumer
// (the consumer's config keeps the template string for intra-node interpolation —
// design A5). A {{nodes.prefix-*.output}} glob becomes a `merge` node fed by the
// matching nodes in sorted id order (the deterministic legacy fan-in, A3.4).

import type {
  WorkflowDefinition,
} from "../../../contracts/src/workflow.ts";
import type {
  WorkflowNode, Predicate,
} from "../../../contracts/src/workflow-node.ts";
import type {
  WorkflowGraph, GraphNode, GraphEdge, NodePort, PortType,
} from "../../../contracts/src/workflow-graph.ts";
import { WORKFLOW_GRAPH_VERSION } from "../../../contracts/src/workflow-graph.ts";

const INPUT_ID = "__input__";
const OUTPUT_ID = "__output__";
const DEFAULT_OUT = "out";
const DEFAULT_IN = "in";

// Loop locals the engine injects per iteration; refs to these inside a loop body
// resolve to the body's input node, never to an outer node.
const LOOP_LOCALS = ["item", "index", "iteration", "lastResult", "lastCount"] as const;
const LOOP_LOCAL_SET = new Set<string>(LOOP_LOCALS);

// ---- ref roots — the parsed head of a {{ … }} binding token -----------------
type RefRoot =
  | { kind: "args" }
  | { kind: "node"; id: string }
  | { kind: "glob"; pattern: string }
  | { kind: "local"; name: string };

interface Anchor { node: string; port: string }
interface Compiled { entries: Anchor[]; anchor: Anchor }
interface DataConsumer { nodeId: string; roots: RefRoot[] }

// A per-graph compilation scope (the top graph and each loop body get their own).
class Scope {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: GraphEdge[] = [];
  readonly anchors = new Map<string, Anchor>();   // v1 node id → output anchor
  private readonly consumers: DataConsumer[] = [];
  private readonly globMerges = new Map<string, Anchor>();
  // Roots that did not resolve within this scope (a loop body forwards these to
  // its loop node so the outer graph wires the real source).
  readonly externals: RefRoot[] = [];

  addNode(node: GraphNode): GraphNode {
    this.nodes.set(node.id, node);
    return node;
  }
  addEdge(from: Anchor, to: Anchor): void {
    this.edges.push({ from: { ...from }, to: { ...to } });
  }
  recordConsumer(nodeId: string, roots: RefRoot[]): void {
    if (roots.length > 0) this.consumers.push({ nodeId, roots });
  }

  // ---- pass 2: turn each consumer's ref roots into data ports + edges --------
  resolveData(resolveRoot: (_root: RefRoot) => Anchor | null): void {
    for (const c of this.consumers) {
      const node = this.nodes.get(c.nodeId);
      if (!node) continue;
      for (const root of c.roots) {
        const source = resolveRoot(root);
        if (!source) continue;                 // unresolved ref → no edge (matches v1's undefined)
        // A node consuming its OWN output (a `loopUntil` whose `until` reads
        // `{{nodes.<loop>.lastCount}}`) needs no edge: that state flows via
        // BindingScope each round, never the frontier. Emitting a self-edge would
        // only force the runtime to defensively drop it.
        if (source.node === c.nodeId) continue;
        const port = portNameFor(root);
        ensureInputPort(node, port);
        this.addEdge(source, { node: node.id, port });
      }
    }
  }

  // The merge node aggregating a glob's matches, created once per pattern.
  globMerge(pattern: string, matches: Anchor[], idFor: (_p: string) => string): Anchor | null {
    if (matches.length === 0) return null;
    const cached = this.globMerges.get(pattern);
    if (cached) return cached;
    const id = idFor(pattern);
    const merge = this.addNode({ id, kind: "merge", outputs: [outPort("array")] });
    for (const m of matches) this.addEdge(m, { node: merge.id, port: DEFAULT_IN });
    const anchor: Anchor = { node: merge.id, port: DEFAULT_OUT };
    this.globMerges.set(pattern, anchor);
    return anchor;
  }
}

// ---- the entry point --------------------------------------------------------
export function treeToGraph(def: WorkflowDefinition): WorkflowGraph {
  const scope = new Scope();
  const argsType: PortType = def.argsSchema === undefined ? "any" : "json";
  scope.addNode({
    id: INPUT_ID,
    kind: "input",
    outputs: [{ name: DEFAULT_OUT, type: argsType, schema: def.argsSchema }],
  });

  const root = compileNode(def.root, scope);
  scope.addNode({ id: OUTPUT_ID, kind: "output", inputs: [{ name: DEFAULT_IN, type: "any" }] });

  // Seed the root's entry handles from the input node, and feed the run result to
  // the output node.
  for (const entry of root.entries) scope.addEdge({ node: INPUT_ID, port: DEFAULT_OUT }, entry);
  scope.addEdge(root.anchor, { node: OUTPUT_ID, port: DEFAULT_IN });

  scope.resolveData((root) => resolveTopRoot(root, scope));

  return {
    name: def.name,
    description: def.description,
    version: WORKFLOW_GRAPH_VERSION,
    experts: def.experts,
    argsSchema: def.argsSchema,
    nodes: [...scope.nodes.values()],
    edges: scope.edges,
  };
}

// Resolve a ref root against the TOP graph: args → the input node; a node id → its
// anchor; a glob → a merge of the sorted matches; a stray local → unresolved.
function resolveTopRoot(root: RefRoot, scope: Scope): Anchor | null {
  switch (root.kind) {
    case "args":
      return { node: INPUT_ID, port: DEFAULT_OUT };
    case "node":
      return scope.anchors.get(root.id) ?? null;
    case "glob": {
      const matches = sortedGlobMatches(root.pattern, scope);
      return scope.globMerge(root.pattern, matches, (p) => `__glob__:${p}`);
    }
    case "local":
      return null;
  }
}

function sortedGlobMatches(pattern: string, scope: Scope): Anchor[] {
  const re = globToRegExp(pattern);
  return [...scope.anchors.keys()]
    .filter((id) => re.test(id))
    .sort()
    .map((id) => scope.anchors.get(id)!);
}

// ---- per-node compilation ---------------------------------------------------
function compileNode(node: WorkflowNode, scope: Scope): Compiled {
  switch (node.type) {
    case "step":
      return leaf(node.id, "worker", scope, refRoots([node.prompt]), {
        config: stepConfig(node),
        outputs: [outPort(node.outputSchema === undefined ? "any" : "json", node.outputSchema)],
      });
    case "script":
      return leaf(node.id, "script", scope, refRoots([node.over, ...(node.args ?? [])]), {
        config: { script: node.script, over: node.over, args: node.args, timeoutMs: node.timeoutMs },
      });
    case "transform":
    case "map":
    case "filter":
    case "dedup":
    case "tally":
    case "accumulate":
      return leaf(node.id, node.type, scope, refRoots([node.over]), {
        config: { fn: "fn" in node ? node.fn : undefined, over: node.over, init: "init" in node ? node.init : undefined },
      });
    case "subWorkflow":
      return leaf(node.id, "subGraph", scope, [], { config: { name: node.name, args: node.args } });
    case "sequence":
      return compileSequence(node.id, node.children, scope);
    case "parallel":
      return compileParallel(node.id, node.children, scope);
    case "phase":
      return compilePhase(node.id, node.label, node.body, scope);
    case "conditional":
      return compileConditional(node, scope);
    case "forEach":
      return compileLoop(node.id, "forEach", node.body, scope, refRoots([node.over]), { over: node.over });
    case "pipeline":
      return compilePipeline(node.id, node.over, node.stages, scope);
    case "loopUntil":
      return compileLoop(node.id, "loopUntil", node.body, scope, predicateRoots(node.until), {
        until: node.until, maxIterations: node.maxIterations,
      });
  }
}

function leaf(
  id: string, kind: string, scope: Scope, roots: RefRoot[],
  extra: { config?: unknown; outputs?: NodePort[] },
): Compiled {
  scope.addNode({ id, kind, config: extra.config, outputs: extra.outputs });
  scope.recordConsumer(id, roots);
  const anchor: Anchor = { node: id, port: DEFAULT_OUT };
  scope.anchors.set(id, anchor);
  return { entries: [{ node: id, port: DEFAULT_IN }], anchor };
}

function compileSequence(id: string, children: WorkflowNode[], scope: Scope): Compiled {
  if (children.length === 0) return emptyContainer(id, scope);
  const compiled = children.map((c) => compileNode(c, scope));
  for (let i = 1; i < compiled.length; i++) {
    for (const entry of compiled[i].entries) scope.addEdge(compiled[i - 1].anchor, entry);
  }
  const anchor = compiled[compiled.length - 1].anchor;
  scope.anchors.set(id, anchor);
  return { entries: compiled[0].entries, anchor };
}

function compileParallel(id: string, children: WorkflowNode[], scope: Scope): Compiled {
  if (children.length === 0) return emptyContainer(id, scope);
  const compiled = children.map((c) => compileNode(c, scope));
  scope.addNode({ id, kind: "merge", inputs: [{ name: DEFAULT_IN, type: "any" }], outputs: [outPort("array")] });
  for (const c of compiled) scope.addEdge(c.anchor, { node: id, port: DEFAULT_IN });
  const anchor: Anchor = { node: id, port: DEFAULT_OUT };
  scope.anchors.set(id, anchor);
  return { entries: compiled.flatMap((c) => c.entries), anchor };
}

function compilePhase(id: string, label: string, body: WorkflowNode, scope: Scope): Compiled {
  const compiled = compileNode(body, scope);
  const anchorNode = scope.nodes.get(compiled.anchor.node);
  if (anchorNode && anchorNode.label === undefined) anchorNode.label = label;
  scope.anchors.set(id, compiled.anchor);
  return compiled;
}

function compileConditional(
  node: Extract<WorkflowNode, { type: "conditional" }>, scope: Scope,
): Compiled {
  const branchId = node.id;
  scope.addNode({
    id: branchId, kind: "branch", config: { predicate: node.predicate },
    inputs: [{ name: DEFAULT_IN, type: "any" }],
    outputs: [{ name: "then", type: "any" }, { name: "else", type: "any" }],
  });
  scope.recordConsumer(branchId, predicateRoots(node.predicate));

  const mergeId = `${node.id}::merge`;
  scope.addNode({ id: mergeId, kind: "merge", inputs: [{ name: DEFAULT_IN, type: "any" }], outputs: [outPort("any")] });

  const thenC = compileNode(node.then, scope);
  for (const entry of thenC.entries) scope.addEdge({ node: branchId, port: "then" }, entry);
  scope.addEdge(thenC.anchor, { node: mergeId, port: DEFAULT_IN });

  if (node.else) {
    const elseC = compileNode(node.else, scope);
    for (const entry of elseC.entries) scope.addEdge({ node: branchId, port: "else" }, entry);
    scope.addEdge(elseC.anchor, { node: mergeId, port: DEFAULT_IN });
  }
  // No else branch: do NOT drain the branch's `else` port into the merge. That
  // spurious edge delivered a `passed` token on a false predicate, so the `any`
  // merge rolled the skipped conditional up to `passed` — a failed→passed flip vs
  // v1 (which returned `skipped`, mapped to a failed run). With no drain edge the
  // merge re-converges only via the (skipped) then-arm, rolling up `skipped` so the
  // run correctly fails — behaviour-preserving.

  const anchor: Anchor = { node: mergeId, port: DEFAULT_OUT };
  scope.anchors.set(node.id, anchor);
  return { entries: [{ node: branchId, port: DEFAULT_IN }], anchor };
}

// pipeline = per-item independent stage CHAIN; the body is the stages run as one
// in-order sequence, encapsulated as a loop body (data-driven over `over`).
function compilePipeline(id: string, over: string, stages: WorkflowNode[], scope: Scope): Compiled {
  const chain: WorkflowNode = { type: "sequence", id: `${id}::chain`, children: stages };
  return compileLoop(id, "pipeline", chain, scope, refRoots([over]), { over });
}

function compileLoop(
  id: string, loopKind: "forEach" | "pipeline" | "loopUntil",
  body: WorkflowNode, scope: Scope, ownRoots: RefRoot[], loopConfig: Record<string, unknown>,
): Compiled {
  const compiledBody = compileLoopBody(id, body);
  const outType: PortType = loopKind === "loopUntil" ? "any" : "array";
  scope.addNode({
    id, kind: "loop", outputs: [outPort(outType)],
    config: { loopKind, ...loopConfig, body: compiledBody.graph },
  });
  // The loop depends on its own refs (over/until) PLUS any external refs its body
  // forwards (so the outer graph wires the real upstream source).
  scope.recordConsumer(id, dedupeRoots([...ownRoots, ...compiledBody.externals]));
  const anchor: Anchor = { node: id, port: DEFAULT_OUT };
  scope.anchors.set(id, anchor);
  return { entries: [{ node: id, port: DEFAULT_IN }], anchor };
}

// Compile a loop body into its own self-contained sub-graph: an input node seeds
// the per-iteration locals (and forwards external refs), the body nodes/edges are
// compiled normally, and an output node carries the body's result.
function compileLoopBody(loopId: string, body: WorkflowNode): { graph: WorkflowGraph; externals: RefRoot[] } {
  const scope = new Scope();
  const input = scope.addNode({ id: INPUT_ID, kind: "input", outputs: [] });

  const compiled = compileNode(body, scope);
  scope.addNode({ id: OUTPUT_ID, kind: "output", inputs: [{ name: DEFAULT_IN, type: "any" }] });
  for (const entry of compiled.entries) scope.addEdge({ node: INPUT_ID, port: DEFAULT_OUT }, entry);
  scope.addEdge(compiled.anchor, { node: OUTPUT_ID, port: DEFAULT_IN });

  scope.resolveData((root) => resolveBodyRoot(root, scope, input));

  // Add the implicit default out port so the seeding edges above stay valid.
  ensureOutputPort(input, DEFAULT_OUT, "any");

  const graph: WorkflowGraph = {
    name: `${loopId}::body`,
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [...scope.nodes.values()],
    edges: scope.edges,
  };
  return { graph, externals: dedupeRoots(scope.externals) };
}

// Resolve a ref root inside a loop body: locals + args + external nodes/globs all
// arrive through the body's input node (forwarded per iteration); in-body node
// refs resolve to their own anchor.
function resolveBodyRoot(root: RefRoot, scope: Scope, input: GraphNode): Anchor | null {
  switch (root.kind) {
    case "local":
      ensureOutputPort(input, root.name, "any");
      return { node: INPUT_ID, port: root.name };
    case "args":
      ensureOutputPort(input, "args", "any");
      scope.externals.push(root);
      return { node: INPUT_ID, port: "args" };
    case "node": {
      const inBody = scope.anchors.get(root.id);
      if (inBody) return inBody;
      ensureOutputPort(input, root.id, "any");
      scope.externals.push(root);
      return { node: INPUT_ID, port: root.id };
    }
    case "glob": {
      const matches = sortedGlobMatches(root.pattern, scope);
      if (matches.length > 0) return scope.globMerge(root.pattern, matches, (p) => `__glob__:${p}`);
      ensureOutputPort(input, root.pattern, "any");
      scope.externals.push(root);
      return { node: INPUT_ID, port: root.pattern };
    }
  }
}

// ---- small helpers ----------------------------------------------------------
function emptyContainer(id: string, scope: Scope): Compiled {
  scope.addNode({ id, kind: "merge", outputs: [outPort("array")] });
  const anchor: Anchor = { node: id, port: DEFAULT_OUT };
  scope.anchors.set(id, anchor);
  return { entries: [{ node: id, port: DEFAULT_IN }], anchor };
}

function stepConfig(node: Extract<WorkflowNode, { type: "step" }>): Record<string, unknown> {
  return {
    from: node.from, prompt: node.prompt, model: node.model, effort: node.effort,
    toolsAllow: node.toolsAllow, toolsDeny: node.toolsDeny,
    outputSchema: node.outputSchema, loop: node.loop,
  };
}

function outPort(type: PortType, schema?: unknown): NodePort {
  return { name: DEFAULT_OUT, type, schema };
}

function portNameFor(root: RefRoot): string {
  switch (root.kind) {
    case "args": return "args";
    case "node": return root.id;
    case "glob": return root.pattern;
    case "local": return root.name;
  }
}

function ensureInputPort(node: GraphNode, name: string): void {
  if (!node.inputs) node.inputs = [];
  if (!node.inputs.some((p) => p.name === name)) node.inputs.push({ name, type: "any" });
}

function ensureOutputPort(node: GraphNode, name: string, type: PortType): void {
  if (!node.outputs) node.outputs = [];
  if (!node.outputs.some((p) => p.name === name)) node.outputs.push({ name, type });
}

// ---- ref extraction ---------------------------------------------------------
const TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;

function refRoots(templates: (string | undefined)[]): RefRoot[] {
  const roots: RefRoot[] = [];
  for (const t of templates) {
    if (t === undefined) continue;
    for (const match of t.matchAll(TOKEN)) roots.push(...rootsOfPath(match[1].trim()));
  }
  return dedupeRoots(roots);
}

// A predicate operand may be a bare path or a braced ref; gather roots from both.
function predicateRoots(pred: Predicate | undefined): RefRoot[] {
  if (!pred) return [];
  const roots: RefRoot[] = [];
  const visit = (p: Predicate): void => {
    switch (p.op) {
      case "eq":
        roots.push(...rootsOfOperand(p.left));
        if (typeof p.right === "string") roots.push(...rootsOfOperand(p.right));
        break;
      case "exists":
        roots.push(...rootsOfOperand(p.ref));
        break;
      case "and":
      case "or":
        p.clauses.forEach(visit);
        break;
    }
  };
  visit(pred);
  return dedupeRoots(roots);
}

function rootsOfOperand(operand: string): RefRoot[] {
  if (operand.includes("{{")) return refRoots([operand]);
  return rootsOfPath(operand);
}

function rootsOfPath(path: string): RefRoot[] {
  if (path === "") return [];
  const parts = path.split(".");
  const head = parts[0];
  if (head === "args") return [{ kind: "args" }];
  if (head === "nodes") {
    const id = parts[1];
    if (!id) return [];
    return id.includes("*") ? [{ kind: "glob", pattern: id }] : [{ kind: "node", id }];
  }
  if (LOOP_LOCAL_SET.has(head)) return [{ kind: "local", name: head }];
  return [];
}

function dedupeRoots(roots: RefRoot[]): RefRoot[] {
  const seen = new Set<string>();
  const out: RefRoot[] = [];
  for (const r of roots) {
    const key = `${r.kind}:${portNameFor(r)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}
