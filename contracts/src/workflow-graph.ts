// workflow-graph.ts — the v2 node-graph contract (design Part A2). The v1 model
// (workflow.ts / workflow-node.ts) is a single-rooted TREE; this is its successor:
// a FLAT graph of `nodes[]` + `edges[]` with first-class `input`/`output` kinds,
// typed ports, and edges that wire an upstream output port to a downstream input
// port. `version: 2` discriminates a graph from a v1 tree (which carries no
// version), so both coexist on disk and in the stores until the runtime flips.
//
// DORMANT in this phase: nothing executes a graph yet. The engine still walks v1
// trees; this file only ADDS the target shape + its structural validation so the
// `treeToGraph` compiler (core/src/workflow/tree-to-graph.ts) and the future
// readiness scheduler (Phase 2) have a contract to build against.
//
// Where the design sketch (A2) was underspecified, the choices here preserve the
// existing executor vocabulary (so kinds map onto existing executors) and keep the
// graph cleanly consumable by a Kahn's-algorithm topological scheduler: a flat
// O(N+E) node/edge set, explicit ordered edges, encapsulated loop bodies.

import { z } from "zod";
import {
  ExpertSpecSchema, WorkflowDefinitionSchema, type ExpertSpec,
  type WorkflowDefinitionRecord,
  type WorkflowDefinitionSource as WorkflowDefinitionProvenance,
} from "./workflow.ts";

// The version literal that discriminates a v2 graph from a v1 tree.
export const WORKFLOW_GRAPH_VERSION = 2 as const;

// ---- port value types — the authoring-time type system for edges -------------
// `json` = a typed object whose shape is the port's `schema` (today only a worker
// node carries one, lowered from v1 `step.outputSchema`); `any` = untyped (today's
// default everywhere). The editor (Phase 5) type-checks edge compatibility against
// these; the scheduler (Phase 2/3) re-validates `json` ports with the same
// compileJsonSchema validator Part B already applies to the output tool arg.
export const PORT_TYPES = ["any", "string", "number", "boolean", "object", "array", "json"] as const;
export const PortTypeSchema = z.enum(PORT_TYPES);
export type PortType = z.infer<typeof PortTypeSchema>;

// Edge type-compatibility (Phase 3): may an upstream OUTPUT port of `from` feed a
// downstream INPUT port of `to`? `any` is the untyped escape hatch — assignable in
// both directions, which keeps every lowered-tree port (treeToGraph defaults inputs
// to `any`) compatible, so legacy graphs never trip the authoring check. `json` is a
// typed object, interchangeable with the untyped `object` type; the runtime schema
// check enforces the actual shape. Otherwise the two concrete types must match.
export function isPortTypeAssignable(from: PortType, to: PortType): boolean {
  if (from === "any" || to === "any") return true;
  if (from === to) return true;
  if ((from === "json" && to === "object") || (from === "object" && to === "json")) return true;
  return false;
}

// ---- node kind vocabulary ---------------------------------------------------
// Mirrors the existing executor registry (core/src/workflow/registry.ts) so each
// kind maps onto an executor. `kind` stays an OPEN `z.string()` (per A2 — adding a
// kind is "new file + one register line"); this const documents the builtin set
// and lets consumers validate against it. The mapping from the v1 16-type union:
//   step                                  → worker
//   script                                → script
//   transform/map/filter/dedup/tally/accumulate → same names (the glue transforms)
//   conditional                           → branch
//   subWorkflow                           → subGraph
//   forEach / loopUntil / pipeline        → loop (encapsulated body sub-graph)
//   sequence / parallel / phase           → graph TOPOLOGY (edges + a `merge`
//                                           fan-in), not standalone kinds
// Plus the two graph-native framing kinds the tree lacked: `input` / `output`.
export const GRAPH_NODE_KINDS = [
  "input",
  "output",
  "worker",
  "script",
  "transform",
  "map",
  "filter",
  "dedup",
  "tally",
  "accumulate",
  "branch",
  "merge",
  "loop",
  "subGraph",
] as const;
export const GraphNodeKindSchema = z.enum(GRAPH_NODE_KINDS);
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

export function isKnownGraphNodeKind(kind: string): kind is GraphNodeKind {
  return (GRAPH_NODE_KINDS as readonly string[]).includes(kind);
}

// ---- ports ------------------------------------------------------------------
// A typed input/output handle on a node. Every node additionally has the IMPLICIT
// default ports `out` (output) and `in` (input) without declaring them — a
// hand-authored edge `{from:{node:a}, to:{node:b}}` defaults to a.out → b.in. Only
// NAMED ports (data ports, a branch's `then`/`else`) must be declared, so the
// structural validator can reject an edge to a port that does not exist.
export const NodePortSchema = z.object({
  name: z.string().min(1),                 // port id, unique within the node's side
  type: PortTypeSchema.default("any"),
  required: z.boolean().optional(),        // a required input that never resolves fails the node (Phase 2)
  schema: z.unknown().optional(),          // JSON-Schema when type === "json"
});
export type NodePort = z.infer<typeof NodePortSchema>;

// ---- node -------------------------------------------------------------------
export const GraphNodeSchema = z.object({
  id: z.string().min(1),                   // UNIQUE within the graph (enforced in superRefine)
  kind: z.string().min(1),                 // registry key — see GRAPH_NODE_KINDS
  label: z.string().optional(),
  config: z.unknown().optional(),          // kind-specific params (prompt, from, fn, predicate, loop body, …)
  inputs: z.array(NodePortSchema).optional(),
  outputs: z.array(NodePortSchema).optional(),
  ui: z.object({ x: z.number(), y: z.number() }).optional(), // canvas layout — ignored at runtime
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

// ---- edge -------------------------------------------------------------------
// Wires one upstream output port to one downstream input port. Many edges MAY
// target the same input port (an ordered fan-in); the scheduler aggregates them in
// edge-declaration order (the determinism contract, A3.4).
export const GraphEdgeSchema = z.object({
  id: z.string().optional(),
  from: z.object({ node: z.string().min(1), port: z.string().min(1).default("out") }),
  to: z.object({ node: z.string().min(1), port: z.string().min(1).default("in") }),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

// The two default ports every node carries implicitly (see NodePortSchema note).
const DEFAULT_OUTPUT_PORT = "out";
const DEFAULT_INPUT_PORT = "in";

// ---- the graph definition ---------------------------------------------------
// Explicit shape for the validator params — naming `z.infer<typeof
// WorkflowGraphSchema>` inside the schema's own superRefine forms a type cycle TS
// rejects, so the structural checks read this hand-written mirror instead.
interface WorkflowGraphShape {
  name: string;
  description?: string;
  version: typeof WORKFLOW_GRAPH_VERSION;
  experts?: ExpertSpec[];
  argsSchema?: unknown;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const WorkflowGraphSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    version: z.literal(WORKFLOW_GRAPH_VERSION),   // discriminates graph(v2) from tree(v1)
    experts: z.array(ExpertSpecSchema).optional(), // KEPT verbatim from v1
    argsSchema: z.unknown().optional(),            // JSON-Schema for run args (the input node's out-port type)
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  })
  .superRefine(validateGraphStructure);
export type WorkflowGraph = z.infer<typeof WorkflowGraphSchema>;

// A definition on disk / in a store is EITHER a v1 tree or a v2 graph. A plain
// union (not discriminatedUnion) because the v1 tree carries no `version` field to
// discriminate on: a graph has `version: 2` + `nodes`/`edges`, a tree has `root`
// and no version, so the two are structurally exclusive. Phase 2 swaps the engine
// dispatch to read this; nothing consumes it yet. The v1 schema is left untouched
// (dormancy) — this only ADDS the either-or wrapper.
export const AnyWorkflowDefinitionSchema = z.union([WorkflowGraphSchema, WorkflowDefinitionSchema]);
export type AnyWorkflowDefinition = z.infer<typeof AnyWorkflowDefinitionSchema>;

// A catalogued definition (v1 tree OR v2 graph) tagged with its provenance — the
// union counterpart of v1's WorkflowDefinitionRecord, so a definition source can
// emit graphs alongside trees. The file source attaches `source` to the validated
// definition; this type is what list()/resolve() carry end to end.
export type AnyWorkflowDefinitionRecord =
  | (WorkflowGraph & { source: WorkflowDefinitionProvenance })
  | WorkflowDefinitionRecord;

// GET /workflows/definitions → the merged builtin + file + runtime definition
// records (each tagged with its provenance) the Library + from/subGraph selectors read.
export type WorkflowDefinitionsResponse = AnyWorkflowDefinitionRecord[];

// Strip the provenance tag back to a bare runnable definition (v1 tree | v2 graph).
export function definitionOfRecord(record: AnyWorkflowDefinitionRecord): AnyWorkflowDefinition {
  const { source: _source, ...def } = record;
  return def as AnyWorkflowDefinition;
}

export function isWorkflowGraph(def: unknown): def is WorkflowGraph {
  return typeof def === "object" && def !== null && (def as { version?: unknown }).version === WORKFLOW_GRAPH_VERSION;
}

// ---- structural validation (A2 superRefine) ---------------------------------
// Enforces the invariants a scheduler relies on, none of which v1 checked:
//   1. exactly one `input` node, at least one `output` node (I/O cardinality)
//   2. node ids unique (the Phase 0A id-uniqueness discipline)
//   3. every edge endpoint references an existing node + a valid port
//   4. the top-level graph is acyclic (loop bodies are encapsulated in config,
//      so they are not part of this node/edge set — A3.3)
function validateGraphStructure(graph: WorkflowGraphShape, ctx: z.RefinementCtx): void {
  const byId = new Map<string, GraphNode>();

  // (2) id uniqueness — report each duplicate once, against the offending node.
  graph.nodes.forEach((node, i) => {
    if (byId.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", i, "id"],
        message: `duplicate node id "${node.id}" — node ids must be unique within a graph`,
      });
      return;
    }
    byId.set(node.id, node);
  });

  // (1) input/output cardinality.
  const inputCount = graph.nodes.filter((n) => n.kind === "input").length;
  const outputCount = graph.nodes.filter((n) => n.kind === "output").length;
  if (inputCount !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nodes"],
      message: `graph must have exactly one "input" node (found ${inputCount})`,
    });
  }
  if (outputCount < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nodes"],
      message: `graph must have at least one "output" node (found ${outputCount})`,
    });
  }

  // (3) edge endpoints — existing node + valid (declared or implicit-default) port.
  graph.edges.forEach((edge, i) => {
    checkEndpoint(ctx, byId, edge.from.node, edge.from.port, "from", "output", i);
    checkEndpoint(ctx, byId, edge.to.node, edge.to.port, "to", "input", i);
  });

  // (3a) self-edges — REJECTED (Phase 4 decision). A self-edge gates a node's
  // readiness on its own output, which can never resolve — it would deadlock the
  // scheduler frontier. The compiler (treeToGraph) never emits one, so a self-edge
  // only appears in a HAND-AUTHORED graph, where it is almost certainly an authoring
  // mistake (the `loopUntil` self-reference flows via BindingScope per iteration, not
  // via an edge). For hand-authored input the safer choice is to reject loudly with a
  // precise message rather than silently drop the edge and run a graph the author did
  // not describe. (The scheduler still drops self-edges defensively as belt-and-braces
  // for any graph that bypasses this schema.)
  reportSelfEdges(ctx, graph);

  // (3b) edge TYPE-compatibility (Phase 3): the source output port type must be
  // assignable to the dest input port type. Only checks edges whose endpoints
  // resolved to real nodes (dangling already reported above); an undeclared /
  // implicit-default port is `any`, so the check is a no-op for them.
  reportEdgeTypeMismatches(ctx, byId, graph);

  // (4) acyclicity (Kahn's): if a topological pass cannot consume every node, an
  // edge cycle remains. Only checks endpoints that resolved to real nodes.
  reportCycle(ctx, graph);
}

function checkEndpoint(
  ctx: z.RefinementCtx,
  byId: Map<string, GraphNode>,
  nodeId: string,
  port: string,
  side: "from" | "to",
  portSide: "input" | "output",
  edgeIndex: number,
): void {
  const node = byId.get(nodeId);
  if (!node) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["edges", edgeIndex, side, "node"],
      message: `edge references unknown node "${nodeId}"`,
    });
    return;
  }
  const declared = portSide === "output" ? node.outputs : node.inputs;
  const implicitDefault = portSide === "output" ? DEFAULT_OUTPUT_PORT : DEFAULT_INPUT_PORT;
  const valid = port === implicitDefault || (declared?.some((p) => p.name === port) ?? false);
  if (!valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["edges", edgeIndex, side, "port"],
      message: `edge references unknown ${portSide} port "${port}" on node "${nodeId}"`,
    });
  }
}

// The declared type of a node's port; an undeclared / implicit-default port is
// untyped (`any`). NodePortSchema defaults `type` to "any", so a declared port
// without an explicit type reads as "any" too.
function portTypeOf(node: GraphNode, port: string, side: "input" | "output"): PortType {
  const declared = side === "output" ? node.outputs : node.inputs;
  return declared?.find((p) => p.name === port)?.type ?? "any";
}

function reportSelfEdges(ctx: z.RefinementCtx, graph: WorkflowGraphShape): void {
  graph.edges.forEach((edge, i) => {
    if (edge.from.node === edge.to.node) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", i],
        message:
          `edge connects node "${edge.from.node}" to itself — self-edges are not allowed ` +
          `(a node cannot depend on its own output; loop a node's body with a "loop" node instead)`,
      });
    }
  });
}

function reportEdgeTypeMismatches(ctx: z.RefinementCtx, byId: Map<string, GraphNode>, graph: WorkflowGraphShape): void {
  graph.edges.forEach((edge, i) => {
    const fromNode = byId.get(edge.from.node);
    const toNode = byId.get(edge.to.node);
    if (!fromNode || !toNode) return; // dangling — already reported
    const fromType = portTypeOf(fromNode, edge.from.port, "output");
    const toType = portTypeOf(toNode, edge.to.port, "input");
    if (!isPortTypeAssignable(fromType, toType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", i],
        message:
          `edge ${edge.from.node}.${edge.from.port} → ${edge.to.node}.${edge.to.port}: ` +
          `output type "${fromType}" is not assignable to input type "${toType}"`,
      });
    }
  });
}

function reportCycle(ctx: z.RefinementCtx, graph: WorkflowGraphShape): void {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    out.set(id, []);
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from.node) || !ids.has(edge.to.node)) continue; // dangling — already reported
    if (edge.from.node === edge.to.node) continue; // self-edge — reported separately by reportSelfEdges
    out.get(edge.from.node)!.push(edge.to.node);
    indegree.set(edge.to.node, (indegree.get(edge.to.node) ?? 0) + 1);
  }
  const queue = [...ids].filter((id) => (indegree.get(id) ?? 0) === 0);
  let consumed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    consumed += 1;
    for (const next of out.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (consumed !== ids.size) {
    const stuck = [...ids].filter((id) => (indegree.get(id) ?? 0) > 0).sort();
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["edges"],
      message: `graph has a cycle — nodes still on a cycle: ${stuck.join(", ")}`,
    });
  }
}
