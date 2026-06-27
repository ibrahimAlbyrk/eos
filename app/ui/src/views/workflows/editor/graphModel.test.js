import { describe, it, expect } from "vitest";
import {
  createInitialGraph, addNode, addEdge, removeNode, toWorkflowGraph,
} from "./graphModel.js";
// Validate the emitted payload against the SAME schema the backend uses, so the
// editor can never produce a graph the daemon would reject (the Save contract).
import { WorkflowGraphSchema } from "../../../../../../contracts/src/workflow-graph.ts";

const workerEntry = { kind: "worker", label: "Worker", category: "compute", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] };
const tallyEntry = { kind: "tally", label: "Tally", category: "transform", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "number" }] };
const mapEntry = { kind: "map", label: "Map", category: "transform", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "array" }] };

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
