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
