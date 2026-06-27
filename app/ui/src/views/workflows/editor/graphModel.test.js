import { describe, it, expect } from "vitest";
import {
  createInitialGraph, addNode, addEdge, removeNode, toWorkflowGraph,
  fanInMode, rerouteEdge, removeNodes, copyNodes, pasteNodes, duplicateNodes, graphFromDoc,
} from "./graphModel.js";
// Validate the emitted payload against the SAME schema the backend uses, so the
// editor can never produce a graph the daemon would reject (the Save contract).
import { WorkflowGraphSchema } from "../../../../../../contracts/src/workflow-graph.ts";

const workerEntry = { kind: "worker", label: "Worker", category: "compute", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] };
const tallyEntry = { kind: "tally", label: "Tally", category: "transform", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "number" }] };
const mapEntry = { kind: "map", label: "Map", category: "transform", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "array" }] };
const mergeEntry = { kind: "merge", label: "Merge", category: "control", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] };

// Two sources + one target of the given entry; returns ids so a fan-in test can
// drive a second/third edge onto the target's single `in` port.
function withTwoSourcesInto(targetEntry) {
  let g = createInitialGraph({ name: "demo" });
  const a = addNode(g, workerEntry); g = a.state;
  const b = addNode(g, workerEntry); g = b.state;
  const t = addNode(g, targetEntry); g = t.state;
  return { g, a: a.node.id, b: b.node.id, t: t.node.id };
}

describe("graphModel", () => {
  it("seeds exactly one input and one output node", () => {
    const g = createInitialGraph();
    expect(g.nodes.filter((n) => n.kind === "input").length).toBe(1);
    expect(g.nodes.filter((n) => n.kind === "output").length).toBe(1);
  });

  it("adds a node and wires a type-compatible edge", () => {
    let g = createInitialGraph();
    const w = addNode(g, workerEntry);
    g = w.state;
    const res = addEdge(g, { node: "input", port: "out" }, { node: w.node.id, port: "in" });
    expect(res.error).toBeUndefined();
    expect(res.state.edges.length).toBe(1);
    expect(res.state.edges[0].from).toEqual({ node: "input", port: "out" });
  });

  it("rejects a type-incompatible edge with a visible reason and no state change", () => {
    let g = createInitialGraph();
    const t = addNode(g, tallyEntry); g = t.state;
    const m = addNode(g, mapEntry); g = m.state;
    // tally.out is `number`, map.in is `array` → not assignable.
    const res = addEdge(g, { node: t.node.id, port: "out" }, { node: m.node.id, port: "in" });
    expect(res.error).toMatch(/not assignable/);
    expect(res.state.edges.length).toBe(0);
  });

  it("rejects self-edges and duplicate edges", () => {
    let g = createInitialGraph();
    const w = addNode(g, workerEntry); g = w.state;
    expect(addEdge(g, { node: w.node.id, port: "out" }, { node: w.node.id, port: "in" }).error).toMatch(/itself/);
    g = addEdge(g, { node: "input", port: "out" }, { node: w.node.id, port: "in" }).state;
    expect(addEdge(g, { node: "input", port: "out" }, { node: w.node.id, port: "in" }).error).toMatch(/already exists/);
  });

  it("emits a v2 WorkflowGraph payload the backend schema accepts", () => {
    let g = createInitialGraph({ name: "demo" });
    const w = addNode(g, workerEntry); g = w.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: w.node.id, port: "in" }).state;
    g = addEdge(g, { node: w.node.id, port: "out" }, { node: "output", port: "in" }).state;

    const payload = toWorkflowGraph(g);
    expect(payload.version).toBe(2);
    expect(payload.name).toBe("demo");
    expect(payload.nodes.map((n) => n.kind).sort()).toEqual(["input", "output", "worker"]);
    expect(payload.edges).toEqual([
      { from: { node: "input", port: "out" }, to: { node: w.node.id, port: "in" } },
      { from: { node: w.node.id, port: "out" }, to: { node: "output", port: "in" } },
    ]);
    expect(() => WorkflowGraphSchema.parse(payload)).not.toThrow();
  });

  it("removeNode drops the node and its incident edges", () => {
    let g = createInitialGraph();
    const w = addNode(g, workerEntry); g = w.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: w.node.id, port: "in" }).state;
    g = removeNode(g, w.node.id);
    expect(g.nodes.find((n) => n.id === w.node.id)).toBeUndefined();
    expect(g.edges.length).toBe(0);
  });
});

describe("graphModel — fan-in REPLACE vs merge-ADD (the source-of-truth rule)", () => {
  it("classifies merge `in` as accumulate (add) and every other kind as replace", () => {
    expect(fanInMode({ kind: "merge" })).toBe("add");
    expect(fanInMode({ kind: "worker" })).toBe("replace");
    expect(fanInMode({ kind: "transform" })).toBe("replace");
    expect(fanInMode({ kind: "output" })).toBe("replace");
    expect(fanInMode(null)).toBe("replace");
  });

  it("REPLACES the existing edge when a second edge lands on a single-input port", () => {
    let { g, a, b, t } = withTwoSourcesInto(workerEntry);
    g = addEdge(g, { node: a, port: "out" }, { node: t, port: "in" }).state;
    const res = addEdge(g, { node: b, port: "out" }, { node: t, port: "in" });
    // Exactly one edge into t.in, now from b; the a→t edge was reported replaced.
    const into = res.state.edges.filter((e) => e.to.node === t && e.to.port === "in");
    expect(into.length).toBe(1);
    expect(into[0].from.node).toBe(b);
    expect(res.replaced.map((e) => e.from.node)).toEqual([a]);
  });

  it("ADDS onto a merge `in`, preserving edge-declaration order across fan-in", () => {
    let { g, a, b, t } = withTwoSourcesInto(mergeEntry);
    const c = addNode(g, workerEntry); g = c.state;
    g = addEdge(g, { node: a, port: "out" }, { node: t, port: "in" }).state;
    g = addEdge(g, { node: b, port: "out" }, { node: t, port: "in" }).state;
    const r = addEdge(g, { node: c.node.id, port: "out" }, { node: t, port: "in" });
    expect(r.replaced).toEqual([]);
    const order = r.state.edges.filter((e) => e.to.node === t).map((e) => e.from.node);
    expect(order).toEqual([a, b, c.node.id]); // declaration order preserved
  });
});

describe("graphModel — rerouteEdge re-targets one edge atomically", () => {
  it("moves an edge to a new compatible input and judges validity without the old edge", () => {
    let g = createInitialGraph();
    const w1 = addNode(g, workerEntry); g = w1.state;
    const w2 = addNode(g, workerEntry); g = w2.state;
    const e = addEdge(g, { node: "input", port: "out" }, { node: w1.node.id, port: "in" });
    g = e.state;
    const r = rerouteEdge(g, e.edge.id, { node: "input", port: "out" }, { node: w2.node.id, port: "in" });
    expect(r.error).toBeUndefined();
    expect(r.state.edges.length).toBe(1);
    expect(r.state.edges[0].to.node).toBe(w2.node.id);
    // re-dropping onto the SAME target is not a self-rejected duplicate (old edge gone first)
    const back = rerouteEdge(r.state, r.edge.id, { node: "input", port: "out" }, { node: w2.node.id, port: "in" });
    expect(back.error).toBeUndefined();
    expect(back.state.edges.length).toBe(1);
  });
});

describe("graphModel — removeNodes multi-delete", () => {
  it("drops a set of nodes + incident edges and never removes seeded input/output", () => {
    let g = createInitialGraph();
    const a = addNode(g, workerEntry); g = a.state;
    const b = addNode(g, workerEntry); g = b.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: a.node.id, port: "in" }).state;
    g = addEdge(g, { node: a.node.id, port: "out" }, { node: b.node.id, port: "in" }).state;
    const next = removeNodes(g, [a.node.id, b.node.id, "input", "output"]);
    expect(next.nodes.map((n) => n.id).sort()).toEqual(["input", "output"]);
    expect(next.edges.length).toBe(0);
  });
});

describe("graphModel — graphFromDoc hydrate (nested loop body / load)", () => {
  it("round-trips a doc and resumes the id counter above existing ids", () => {
    let g = createInitialGraph({ name: "doc" });
    const a = addNode(g, workerEntry); g = a.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: a.node.id, port: "in" }).state;
    g = addEdge(g, { node: a.node.id, port: "out" }, { node: "output", port: "in" }).state;
    const doc = toWorkflowGraph(g);

    const hydrated = graphFromDoc(doc);
    // the emitted graph from the hydrated state equals the original doc
    expect(toWorkflowGraph(hydrated)).toEqual(doc);
    // counter resumed above the worker-N id, so a fresh add never collides
    const added = addNode(hydrated, workerEntry);
    expect(hydrated.nodes.some((n) => n.id === added.node.id)).toBe(false);
    expect(() => WorkflowGraphSchema.parse(toWorkflowGraph(added.state))).not.toThrow();
  });

  it("defaults missing edge ids + ui without throwing", () => {
    const doc = {
      name: "bare", version: 2,
      nodes: [
        { id: "input", kind: "input", outputs: [{ name: "out", type: "any" }] },
        { id: "output", kind: "output", inputs: [{ name: "in", type: "any" }] },
      ],
      edges: [{ from: { node: "input", port: "out" }, to: { node: "output", port: "in" } }],
    };
    const hydrated = graphFromDoc(doc);
    expect(hydrated.edges[0].id).toMatch(/^e-/);
    expect(hydrated.nodes[0].ui).toBeTruthy();
    expect(() => WorkflowGraphSchema.parse(toWorkflowGraph(hydrated))).not.toThrow();
  });
});

describe("graphModel — copy/paste id-remap + internal-edge preservation", () => {
  it("pastes with fresh ids, preserves the internal edge, offsets position, drops external edges", () => {
    let g = createInitialGraph();
    const a = addNode(g, workerEntry); g = a.state;
    const b = addNode(g, workerEntry); g = b.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: a.node.id, port: "in" }).state; // external
    g = addEdge(g, { node: a.node.id, port: "out" }, { node: b.node.id, port: "in" }).state; // internal

    const clip = copyNodes(g, [a.node.id, b.node.id]);
    expect(clip.nodes.length).toBe(2);
    expect(clip.edges.length).toBe(1); // only the internal a→b edge, not input→a

    const pasted = pasteNodes(g, clip, { x: 40, y: 40 });
    expect(pasted.nodeIds.length).toBe(2);
    // fresh ids, none colliding with the originals
    expect(pasted.nodeIds).not.toContain(a.node.id);
    expect(pasted.nodeIds).not.toContain(b.node.id);
    const newSet = new Set(pasted.nodeIds);
    const newInternal = pasted.state.edges.filter((e) => newSet.has(e.from.node) && newSet.has(e.to.node));
    expect(newInternal.length).toBe(1); // internal edge re-pointed at the new ids
    expect(newInternal[0].from.node).toBe(pasted.nodeIds[0]);
    expect(newInternal[0].to.node).toBe(pasted.nodeIds[1]);
    // position offset applied
    const srcA = g.nodes.find((n) => n.id === a.node.id);
    const newA = pasted.state.nodes.find((n) => n.id === pasted.nodeIds[0]);
    expect(newA.ui).toEqual({ x: srcA.ui.x + 40, y: srcA.ui.y + 40 });
  });

  it("duplicate = copy+paste; a second paste of one clipboard yields distinct ids each time", () => {
    let g = createInitialGraph();
    const a = addNode(g, workerEntry); g = a.state;
    const d1 = duplicateNodes(g, [a.node.id]);
    const clip = copyNodes(g, [a.node.id]);
    const p1 = pasteNodes(g, clip);
    const p2 = pasteNodes(p1.state, clip);
    expect(d1.nodeIds.length).toBe(1);
    expect(p1.nodeIds[0]).not.toEqual(p2.nodeIds[0]); // each paste gets fresh ids
  });

  it("excludes seeded input/output from a copy (their cardinality is fixed)", () => {
    let g = createInitialGraph();
    const a = addNode(g, workerEntry); g = a.state;
    const clip = copyNodes(g, ["input", "output", a.node.id]);
    expect(clip.nodes.map((n) => n.kind)).toEqual(["worker"]);
  });

  it("emitted paste output stays schema-valid", () => {
    let g = createInitialGraph({ name: "demo" });
    const a = addNode(g, workerEntry); g = a.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: a.node.id, port: "in" }).state;
    g = addEdge(g, { node: a.node.id, port: "out" }, { node: "output", port: "in" }).state;
    g = duplicateNodes(g, [a.node.id]).state;
    expect(() => WorkflowGraphSchema.parse(toWorkflowGraph(g))).not.toThrow();
  });
});
