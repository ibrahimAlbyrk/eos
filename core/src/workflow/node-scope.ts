// node-scope.ts — per-iteration id scoping for the data-driven fan-out nodes
// (forEach / pipeline / loopUntil) and per-call scoping for subWorkflow. Each
// iteration re-runs the same body subtree, so its node ids must be made unique or
// the journal PK (`${runId}:${nodeId}`) and the binding scope collide across
// iterations (P2's flagged concern). `scopeNodeIds` returns a DEEP clone of the
// subtree with every node id suffixed, and rewrites every in-subtree binding
// reference (`{{nodes.<id>…}}`) to the suffixed id so cross-node refs inside one
// iteration keep resolving to that iteration's outputs. Refs that point OUTSIDE
// the subtree (`{{args.*}}`, `{{item}}`, a prior sibling node) are left intact.
// Pure: no Node, no Date.now/Math.random.

import type {
  WorkflowNode, Predicate,
} from "../../../contracts/src/workflow-node.ts";
import type {
  WorkflowGraph, GraphNode, GraphEdge,
} from "../../../contracts/src/workflow-graph.ts";

// Mirrors the binding token in bindings.ts — a path inside `{{ … }}`. Kept local
// so this pure tree-rewriter does not reach into BindingScope internals.
const TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;

// Deep-clone `node`, suffixing every id and every reference that targets one of
// the subtree's own ids. `knownIds` defaults to the ids in `node` itself; callers
// that scope a GROUP of sibling subtrees as one unit (the pipeline stage chain)
// pass the union so cross-stage refs are rewritten too.
export function scopeNodeIds(node: WorkflowNode, suffix: string, knownIds?: Set<string>): WorkflowNode {
  const ids = knownIds ?? collectIds(node);
  return rewriteNode(node, suffix, ids);
}

export function collectIds(node: WorkflowNode, acc: Set<string> = new Set()): Set<string> {
  acc.add(node.id);
  for (const child of childrenOf(node)) collectIds(child, acc);
  return acc;
}

// Walk the full node tree and return every id that appears more than once. Node
// ids are run-scoped binding keys (the journal PK `${runId}:${nodeId}` and the
// BindingScope output map), so a duplicate silently clobbers a node's output
// binding (last-write-wins). Definition-acceptance callers reject any definition
// carrying duplicates. Sorted so the rejection names the same id every run.
export function findDuplicateIds(node: WorkflowNode): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const walk = (n: WorkflowNode): void => {
    if (seen.has(n.id)) dupes.add(n.id);
    else seen.add(n.id);
    for (const child of childrenOf(n)) walk(child);
  };
  walk(node);
  return [...dupes].sort();
}

// Visit `node` and every descendant (pre-order). The manager uses it to attach a
// JSON-Schema validator to each `step` node carrying an inline `outputSchema` at
// run acceptance — the tree-structure knowledge stays here, the validation
// concretion stays in the manager (§Issue B).
export function forEachNode(node: WorkflowNode, visit: (_node: WorkflowNode) => void): void {
  visit(node);
  for (const child of childrenOf(node)) forEachNode(child, visit);
}

// Does `node` or any descendant carry the given `type`? The trust gate (§ITEM 1c)
// uses it to reject a run-inline spec that smuggles a `script` node — script nodes
// are allowed only from trusted stored/builtin/file definitions.
export function containsNodeType(node: WorkflowNode, type: WorkflowNode["type"]): boolean {
  if (node.type === type) return true;
  return childrenOf(node).some((child) => containsNodeType(child, type));
}

function childrenOf(node: WorkflowNode): WorkflowNode[] {
  switch (node.type) {
    case "sequence":
    case "parallel":
      return node.children;
    case "pipeline":
      return node.stages;
    case "forEach":
    case "loopUntil":
    case "phase":
      return [node.body];
    case "conditional":
      return node.else ? [node.then, node.else] : [node.then];
    default:
      return [];
  }
}

function rewriteNode(node: WorkflowNode, suffix: string, ids: Set<string>): WorkflowNode {
  const id = `${node.id}${suffix}`;
  switch (node.type) {
    case "step":
      return { ...node, id, prompt: rewriteRefs(node.prompt, suffix, ids) };
    case "script":
      return {
        ...node, id,
        over: node.over !== undefined ? rewriteRefs(node.over, suffix, ids) : undefined,
        args: node.args?.map((a) => rewriteRefs(a, suffix, ids)),
      };
    case "sequence":
      return { ...node, id, children: node.children.map((c) => rewriteNode(c, suffix, ids)) };
    case "parallel":
      return { ...node, id, children: node.children.map((c) => rewriteNode(c, suffix, ids)) };
    case "pipeline":
      return { ...node, id, over: rewriteRefs(node.over, suffix, ids), stages: node.stages.map((c) => rewriteNode(c, suffix, ids)) };
    case "forEach":
      return { ...node, id, over: rewriteRefs(node.over, suffix, ids), body: rewriteNode(node.body, suffix, ids) };
    case "conditional":
      return {
        ...node, id,
        predicate: rewritePredicate(node.predicate, suffix, ids),
        then: rewriteNode(node.then, suffix, ids),
        else: node.else ? rewriteNode(node.else, suffix, ids) : undefined,
      };
    case "loopUntil":
      return {
        ...node, id,
        body: rewriteNode(node.body, suffix, ids),
        until: node.until ? rewritePredicate(node.until, suffix, ids) : undefined,
      };
    case "phase":
      return { ...node, id, body: rewriteNode(node.body, suffix, ids) };
    case "subWorkflow":
      return { ...node, id };
    case "transform":
    case "map":
    case "filter":
    case "dedup":
    case "tally":
    case "accumulate":
      return { ...node, id, over: rewriteRefs(node.over, suffix, ids) };
  }
}

// Rewrite `{{nodes.<id>…}}` tokens whose `<id>` segment is a subtree-local id.
// A glob segment (carrying `*`) is left untouched — it aggregates across the run,
// not within one iteration.
function rewriteRefs(template: string, suffix: string, ids: Set<string>): string {
  return template.replace(TOKEN, (match, inner: string) => {
    const parts = inner.trim().split(".");
    if (parts[0] === "nodes" && parts[1] && !parts[1].includes("*") && ids.has(parts[1])) {
      parts[1] = `${parts[1]}${suffix}`;
      return `{{${parts.join(".")}}}`;
    }
    return match;
  });
}

// Predicate operands (`left` / `ref` / a `{{…}}` `right`) may be bare paths or
// braced refs; rewrite both forms.
function rewriteRef(ref: string, suffix: string, ids: Set<string>): string {
  if (ref.includes("{{")) return rewriteRefs(ref, suffix, ids);
  const parts = ref.split(".");
  if (parts[0] === "nodes" && parts[1] && !parts[1].includes("*") && ids.has(parts[1])) {
    parts[1] = `${parts[1]}${suffix}`;
    return parts.join(".");
  }
  return ref;
}

function rewritePredicate(pred: Predicate, suffix: string, ids: Set<string>): Predicate {
  switch (pred.op) {
    case "eq":
      return {
        op: "eq",
        left: rewriteRef(pred.left, suffix, ids),
        right: typeof pred.right === "string" ? rewriteRef(pred.right, suffix, ids) : pred.right,
      };
    case "exists":
      return { op: "exists", ref: rewriteRef(pred.ref, suffix, ids) };
    case "and":
      return { op: "and", clauses: pred.clauses.map((c) => rewritePredicate(c, suffix, ids)) };
    case "or":
      return { op: "or", clauses: pred.clauses.map((c) => rewritePredicate(c, suffix, ids)) };
  }
}

// ---- graph (v2) analogs — per-iteration scoping for a loop body / subGraph -----
// The graph scheduler (Phase 2) re-runs an encapsulated `loop` body sub-graph (or a
// `subGraph` call) per iteration, so the SAME node ids would collide in the journal
// PK (`${runId}:${nodeId}`) and the binding scope across iterations — the exact P2
// concern `scopeNodeIds` solves for the v1 tree. `scopeGraphNodeIds` is the flat
// node/edge analog: a DEEP clone with every node id suffixed, every edge endpoint
// re-pointed, and every in-graph `{{nodes.<id>…}}` ref in a node's config rewritten
// to the suffixed id (refs OUTSIDE the sub-graph — `{{args.*}}`, loop locals, an
// external node fed through the body's input — are left intact, exactly as the v1
// rewriter leaves them). Pure: no Node, no Date.now/Math.random.

export function collectGraphIds(graph: WorkflowGraph): Set<string> {
  return new Set(graph.nodes.map((n) => n.id));
}

export function scopeGraphNodeIds(graph: WorkflowGraph, suffix: string): WorkflowGraph {
  const ids = collectGraphIds(graph);
  return {
    ...graph,
    nodes: graph.nodes.map((n) => scopeGraphNode(n, suffix, ids)),
    edges: graph.edges.map((e) => scopeGraphEdge(e, suffix, ids)),
  };
}

function scopeGraphNode(node: GraphNode, suffix: string, ids: Set<string>): GraphNode {
  return { ...node, id: `${node.id}${suffix}`, config: scopeGraphConfig(node.kind, node.config, suffix, ids) };
}

// An edge endpoint is suffixed iff it names a node inside this sub-graph (it always
// does — a body sub-graph is self-contained — but the guard keeps it total).
function scopeGraphEdge(edge: GraphEdge, suffix: string, ids: Set<string>): GraphEdge {
  const re = (id: string): string => (ids.has(id) ? `${id}${suffix}` : id);
  return {
    ...edge,
    from: { ...edge.from, node: re(edge.from.node) },
    to: { ...edge.to, node: re(edge.to.node) },
  };
}

// Rewrite the ref-bearing fields of a node's (kind-specific) config — the same
// fields the executors resolve from bindings (`prompt` / `over` / `args` /
// `predicate` / `until`). For a `loop` node we ALSO deep-scope `config.body`: the
// body is its own sub-graph re-run per iteration, so when an OUTER loop scopes its
// body with suffix S and that body contains an inner loop, the inner body's ids/refs
// must also pick up S — otherwise the inner body re-runs with only its own per-
// iteration suffix and its journal PK (`${runId}:${nodeId}`) collides across the
// outer iterations (D2). Scoping is recursive, so a loop-in-loop composes outer+inner
// suffixes (`leaf` → `leaf#i` here → `leaf#i#j` when the inner loop runs). A single-
// level loop body is scoped only when THAT loop runs (this path is never reached for
// it), so single-level journaling is unchanged.
function scopeGraphConfig(kind: string, config: unknown, suffix: string, ids: Set<string>): unknown {
  if (config === null || typeof config !== "object") return config;
  const c = config as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  if (typeof c.prompt === "string") out.prompt = rewriteRefs(c.prompt, suffix, ids);
  if (typeof c.over === "string") out.over = rewriteRefs(c.over, suffix, ids);
  if (Array.isArray(c.args)) out.args = c.args.map((a) => (typeof a === "string" ? rewriteRefs(a, suffix, ids) : a));
  if (isPredicate(c.predicate)) out.predicate = rewritePredicate(c.predicate, suffix, ids);
  if (isPredicate(c.until)) out.until = rewritePredicate(c.until, suffix, ids);
  if (kind === "loop" && isGraphLike(c.body)) out.body = scopeGraphNodeIds(c.body, suffix);
  return out;
}

// A loop's `config.body` is a self-contained WorkflowGraph (nodes[] + edges[]).
function isGraphLike(v: unknown): v is WorkflowGraph {
  return typeof v === "object" && v !== null && Array.isArray((v as { nodes?: unknown }).nodes);
}

function isPredicate(v: unknown): v is Predicate {
  return typeof v === "object" && v !== null && typeof (v as { op?: unknown }).op === "string";
}
