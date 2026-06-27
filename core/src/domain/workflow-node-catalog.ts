// Pure render of the graph node-kind PALETTE — each authoring kind (the
// GRAPH_NODE_KINDS vocabulary from contracts) tagged with a UI category and its
// DEFAULT typed port shape. The node-editor (Phase 5) reads this over
// GET /workflows/catalog to draw the palette + the handles on each node, and to
// type-check edges (the port types feed isPortTypeAssignable). Kept pure +
// Clock-free so it lives in core/domain beside renderCapabilityCatalog; the
// manager composes it with the LIVE transform-fn names from the registry.
//
// The defaults mirror how treeToGraph lowers v1 nodes: a kind whose data shape is
// open defaults its ports to `any` (compatible with everything, like a lowered
// tree); the transform family that operates over a list defaults to `array`, and
// `tally` reduces a list to a `number`, so the editor can demonstrate a real
// type mismatch without any inspector edits. The author may retype any port.

import { GRAPH_NODE_KINDS, type GraphNodeKind, type PortType } from "../../../contracts/src/workflow-graph.ts";

export interface CatalogPort {
  name: string;
  type: PortType;
}

export interface NodeKindCatalogEntry {
  kind: GraphNodeKind;
  label: string;
  category: "io" | "compute" | "transform" | "control" | "composite";
  description: string;
  inputs: CatalogPort[];
  outputs: CatalogPort[];
}

const IN = (type: PortType = "any"): CatalogPort => ({ name: "in", type });
const OUT = (type: PortType = "any"): CatalogPort => ({ name: "out", type });

const ENTRIES: Record<GraphNodeKind, Omit<NodeKindCatalogEntry, "kind">> = {
  input: {
    label: "Input", category: "io",
    description: "Graph entry — seeds the run args onto its output port.",
    inputs: [], outputs: [OUT()],
  },
  output: {
    label: "Output", category: "io",
    description: "Graph exit — its resolved input is the run result.",
    inputs: [IN()], outputs: [],
  },
  worker: {
    label: "Worker", category: "compute",
    description: "Run a worker-agent node; emits one typed output via the output tool.",
    inputs: [IN()], outputs: [OUT()],
  },
  script: {
    label: "Script", category: "compute",
    description: "Run a trusted local script from the operator allowlist.",
    inputs: [IN()], outputs: [OUT()],
  },
  transform: {
    label: "Transform", category: "transform",
    description: "Apply a named transform fn to the input value.",
    inputs: [IN()], outputs: [OUT()],
  },
  map: {
    label: "Map", category: "transform",
    description: "Map a fn over each element of a list.",
    inputs: [IN("array")], outputs: [OUT("array")],
  },
  filter: {
    label: "Filter", category: "transform",
    description: "Keep list elements matching a predicate.",
    inputs: [IN("array")], outputs: [OUT("array")],
  },
  dedup: {
    label: "Dedup", category: "transform",
    description: "Drop duplicate list elements (stable order).",
    inputs: [IN("array")], outputs: [OUT("array")],
  },
  tally: {
    label: "Tally", category: "transform",
    description: "Count the elements of a list.",
    inputs: [IN("array")], outputs: [OUT("number")],
  },
  accumulate: {
    label: "Accumulate", category: "transform",
    description: "Fold a list into a single accumulated value.",
    inputs: [IN("array")], outputs: [OUT()],
  },
  branch: {
    label: "Branch", category: "control",
    description: "Evaluate a predicate; activate exactly one outgoing edge.",
    inputs: [IN()], outputs: [{ name: "then", type: "any" }, { name: "else", type: "any" }],
  },
  merge: {
    label: "Merge", category: "control",
    description: "Take the first non-skipped input by edge order (ordered join).",
    inputs: [IN()], outputs: [OUT()],
  },
  loop: {
    label: "Loop", category: "control",
    description: "Re-run an encapsulated body sub-graph until a predicate holds.",
    inputs: [IN()], outputs: [OUT()],
  },
  subGraph: {
    label: "Sub-graph", category: "composite",
    description: "Run another workflow graph as one node.",
    inputs: [IN()], outputs: [OUT()],
  },
};

export function buildWorkflowNodeCatalog(): NodeKindCatalogEntry[] {
  return GRAPH_NODE_KINDS.map((kind) => ({ kind, ...ENTRIES[kind] }));
}
