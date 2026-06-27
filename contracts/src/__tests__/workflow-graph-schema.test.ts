import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowGraphSchema,
  AnyWorkflowDefinitionSchema,
  isWorkflowGraph,
  GRAPH_NODE_KINDS,
  isKnownGraphNodeKind,
  WORKFLOW_GRAPH_VERSION,
  type WorkflowGraph,
} from "../workflow-graph.ts";

// A structurally-minimal valid graph: exactly one input, one output, no edges.
function baseGraph(over: Partial<WorkflowGraph> = {}): unknown {
  return {
    name: "g",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input", outputs: [{ name: "out", type: "any" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [],
    ...over,
  };
}

function firstError(result: ReturnType<typeof WorkflowGraphSchema.safeParse>): string {
  assert.equal(result.success, false);
  return result.success ? "" : result.error.issues.map((i) => i.message).join(" | ");
}

describe("WorkflowGraph schema — vocabulary", () => {
  it("declares the builtin node-kind set covering the v1 executor vocabulary", () => {
    for (const k of ["input", "output", "worker", "script", "transform", "map", "filter",
      "dedup", "tally", "accumulate", "branch", "merge", "loop", "subGraph"]) {
      assert.ok((GRAPH_NODE_KINDS as readonly string[]).includes(k), `missing kind ${k}`);
    }
    assert.ok(isKnownGraphNodeKind("worker"));
    assert.ok(!isKnownGraphNodeKind("nope"));
  });

  it("version literal is 2", () => {
    assert.equal(WORKFLOW_GRAPH_VERSION, 2);
  });
});

describe("WorkflowGraph schema — accepts valid graphs", () => {
  it("accepts a minimal one-input/one-output graph", () => {
    assert.equal(WorkflowGraphSchema.safeParse(baseGraph()).success, true);
  });

  it("applies edge port defaults (out → in)", () => {
    const parsed = WorkflowGraphSchema.safeParse(baseGraph({
      edges: [{ from: { node: "in" }, to: { node: "out" } }],
    }));
    assert.equal(parsed.success, true);
    if (parsed.success) {
      assert.equal(parsed.data.edges[0].from.port, "out");
      assert.equal(parsed.data.edges[0].to.port, "in");
    }
  });

  it("accepts edges into declared named ports", () => {
    const parsed = WorkflowGraphSchema.safeParse(baseGraph({
      nodes: [
        { id: "in", kind: "input", outputs: [{ name: "out", type: "any" }] },
        { id: "w", kind: "worker", inputs: [{ name: "args", type: "any" }], outputs: [{ name: "out", type: "json" }] },
        { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
      ],
      edges: [
        { from: { node: "in", port: "out" }, to: { node: "w", port: "args" } },
        { from: { node: "w", port: "out" }, to: { node: "out", port: "in" } },
      ],
    }));
    assert.equal(parsed.success, true);
  });

  it("accepts multiple edges fanning into one input port (ordered fan-in)", () => {
    const parsed = WorkflowGraphSchema.safeParse(baseGraph({
      nodes: [
        { id: "in", kind: "input" },
        { id: "a", kind: "worker" },
        { id: "b", kind: "worker" },
        { id: "m", kind: "merge" },
        { id: "out", kind: "output" },
      ],
      edges: [
        { from: { node: "in" }, to: { node: "a" } },
        { from: { node: "in" }, to: { node: "b" } },
        { from: { node: "a" }, to: { node: "m" } },
        { from: { node: "b" }, to: { node: "m" } },
        { from: { node: "m" }, to: { node: "out" } },
      ],
    }));
    assert.equal(parsed.success, true);
  });
});

describe("WorkflowGraph schema — rejects malformed graphs", () => {
  it("rejects a duplicate node id", () => {
    const r = WorkflowGraphSchema.safeParse(baseGraph({
      nodes: [
        { id: "in", kind: "input" },
        { id: "dup", kind: "worker" },
        { id: "dup", kind: "worker" },
        { id: "out", kind: "output" },
      ],
    }));
    assert.match(firstError(r), /duplicate node id "dup"/);
  });

  it("rejects an edge to an unknown node (dangling edge)", () => {
    const r = WorkflowGraphSchema.safeParse(baseGraph({
      edges: [{ from: { node: "in" }, to: { node: "ghost" } }],
    }));
    assert.match(firstError(r), /unknown node "ghost"/);
  });

  it("rejects an edge to an undeclared named port (missing port)", () => {
    const r = WorkflowGraphSchema.safeParse(baseGraph({
      edges: [{ from: { node: "in", port: "out" }, to: { node: "out", port: "bogus" } }],
    }));
    assert.match(firstError(r), /unknown input port "bogus" on node "out"/);
  });

  it("rejects zero input nodes (bad cardinality)", () => {
    const r = WorkflowGraphSchema.safeParse({
      name: "g", version: 2,
      nodes: [{ id: "out", kind: "output" }],
      edges: [],
    });
    assert.match(firstError(r), /exactly one "input" node \(found 0\)/);
  });

  it("rejects two input nodes (bad cardinality)", () => {
    const r = WorkflowGraphSchema.safeParse({
      name: "g", version: 2,
      nodes: [{ id: "in1", kind: "input" }, { id: "in2", kind: "input" }, { id: "out", kind: "output" }],
      edges: [],
    });
    assert.match(firstError(r), /exactly one "input" node \(found 2\)/);
  });

  it("rejects zero output nodes (bad cardinality)", () => {
    const r = WorkflowGraphSchema.safeParse({
      name: "g", version: 2,
      nodes: [{ id: "in", kind: "input" }],
      edges: [],
    });
    assert.match(firstError(r), /at least one "output" node \(found 0\)/);
  });

  it("rejects a cycle in the top-level graph", () => {
    const r = WorkflowGraphSchema.safeParse(baseGraph({
      nodes: [
        { id: "in", kind: "input" },
        { id: "a", kind: "worker" },
        { id: "b", kind: "worker" },
        { id: "out", kind: "output" },
      ],
      edges: [
        { from: { node: "in" }, to: { node: "a" } },
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "a" } },
        { from: { node: "a" }, to: { node: "out" } },
      ],
    }));
    assert.match(firstError(r), /cycle/);
  });

  it("rejects a self-edge (a node wired to itself), naming the node", () => {
    const r = WorkflowGraphSchema.safeParse(baseGraph({
      nodes: [
        { id: "in", kind: "input" },
        { id: "w", kind: "worker" },
        { id: "out", kind: "output" },
      ],
      edges: [
        { from: { node: "in" }, to: { node: "w" } },
        { from: { node: "w" }, to: { node: "w" } },
        { from: { node: "w" }, to: { node: "out" } },
      ],
    }));
    assert.match(firstError(r), /connects node "w" to itself|self-edges are not allowed/);
  });

  it("rejects the wrong version literal", () => {
    assert.equal(WorkflowGraphSchema.safeParse(baseGraph({ version: 1 as unknown as 2 })).success, false);
  });
});

describe("coexistence with v1 trees", () => {
  const v1Tree = { name: "t", root: { type: "step", id: "s", prompt: "p" } };

  it("isWorkflowGraph distinguishes a v2 graph from a v1 tree", () => {
    assert.equal(isWorkflowGraph(baseGraph()), true);
    assert.equal(isWorkflowGraph(v1Tree), false);
  });

  it("AnyWorkflowDefinitionSchema accepts both a v1 tree and a v2 graph", () => {
    assert.equal(AnyWorkflowDefinitionSchema.safeParse(v1Tree).success, true);
    assert.equal(AnyWorkflowDefinitionSchema.safeParse(baseGraph()).success, true);
  });
});
