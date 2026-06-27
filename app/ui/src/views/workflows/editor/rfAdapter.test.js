import { describe, it, expect } from "vitest";
import {
  toRfNode, toRfNodes, toRfEdge, toRfEdges,
  fromRfConnection, connectionIsValid, handleReceptivity,
  edgeSourceType, edgeFlowActive,
} from "./rfAdapter.js";
import { createInitialGraph, addNode, addEdge, canConnect } from "./graphModel.js";

const workerEntry = { kind: "worker", label: "Worker", category: "compute", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] };
const tallyEntry = { kind: "tally", label: "Tally", category: "transform", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "number" }] };
const mapEntry = { kind: "map", label: "Map", category: "transform", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "array" }] };

// A graph with input → worker, so there is a connectable surface to map + probe.
function withWorker() {
  let g = createInitialGraph({ name: "demo" });
  const w = addNode(g, workerEntry);
  g = w.state;
  return { g, workerId: w.node.id };
}

describe("rfAdapter — graphModel → React Flow node mapping", () => {
  it("maps each graphModel node to an RF node with id, type, position from ui.{x,y}, and port data", () => {
    const { g, workerId } = withWorker();
    const nodes = toRfNodes(g);
    expect(nodes.map((n) => n.id).sort()).toEqual(["input", "output", workerId].sort());

    const worker = nodes.find((n) => n.id === workerId);
    const source = g.nodes.find((n) => n.id === workerId);
    expect(worker.type).toBe("wfNode");
    expect(worker.position).toEqual({ x: source.ui.x, y: source.ui.y });
    expect(worker.data.kind).toBe("worker");
    expect(worker.data.inputs).toEqual([{ name: "in", type: "any" }]);
    expect(worker.data.outputs).toEqual([{ name: "out", type: "any" }]);
  });

  it("marks seeded input/output nodes non-deletable and other nodes deletable", () => {
    const { g, workerId } = withWorker();
    const byId = Object.fromEntries(toRfNodes(g).map((n) => [n.id, n]));
    expect(byId.input.deletable).toBe(false);
    expect(byId.output.deletable).toBe(false);
    expect(byId[workerId].deletable).toBe(true);
  });

  it("threads live run nodeStates into data.status (selection is RF-owned, not set here)", () => {
    const { g, workerId } = withWorker();
    const n = toRfNode(g.nodes.find((x) => x.id === workerId), { nodeStates: { [workerId]: "running" } });
    expect(n.data.status).toBe("running");
    expect(n.selected).toBeUndefined(); // selection lives in RF, not the adapter
    const input = toRfNode(g.nodes.find((x) => x.id === "input"), { nodeStates: { [workerId]: "running" } });
    expect(input.data.status).toBe(null);
  });
});

describe("rfAdapter — edge mapping round-trips graphModel ⇄ React Flow", () => {
  it("maps a graphModel edge to an RF edge with port names as handle ids", () => {
    let { g, workerId } = withWorker();
    g = addEdge(g, { node: "input", port: "out" }, { node: workerId, port: "in" }).state;
    const [e] = toRfEdges(g);
    expect(toRfEdge(g.edges[0], { graph: g })).toEqual(e);
    expect(e).toMatchObject({ source: "input", sourceHandle: "out", target: workerId, targetHandle: "in", type: "wfEdge" });
  });

  it("fromRfConnection turns an RF connection back into graphModel endpoints", () => {
    const { workerId } = withWorker();
    const conn = { source: "input", sourceHandle: "out", target: workerId, targetHandle: "in" };
    expect(fromRfConnection(conn)).toEqual({
      from: { node: "input", port: "out" },
      to: { node: workerId, port: "in" },
    });
  });
});

describe("rfAdapter — edge visual hints (typed color + run-flow)", () => {
  it("edgeSourceType reads the source output port's declared type", () => {
    let g = createInitialGraph();
    const t = addNode(g, tallyEntry); g = t.state; // out: number
    g = addEdge(g, { node: t.node.id, port: "out" }, { node: "output", port: "in" }).state;
    expect(edgeSourceType(g, g.edges[0])).toBe("number");
  });

  it("toRfEdge carries the source type onto data.type (drives the wire hue)", () => {
    let g = createInitialGraph();
    const t = addNode(g, tallyEntry); g = t.state;
    g = addEdge(g, { node: t.node.id, port: "out" }, { node: "output", port: "in" }).state;
    expect(toRfEdge(g.edges[0], { graph: g }).data.type).toBe("number");
  });

  it("edgeFlowActive animates only an edge whose target is running and source produced", () => {
    expect(edgeFlowActive("passed", "running")).toBe(true);
    expect(edgeFlowActive("running", "running")).toBe(true);
    expect(edgeFlowActive("passed", "passed")).toBe(false); // run terminal → no flow
    expect(edgeFlowActive("running", "pending")).toBe(false);
    expect(edgeFlowActive(undefined, undefined)).toBe(false);
  });

  it("toRfEdges threads live nodeStates into data.flow per edge", () => {
    let { g, workerId } = withWorker();
    g = addEdge(g, { node: "input", port: "out" }, { node: workerId, port: "in" }).state;
    const live = toRfEdges(g, { nodeStates: { input: "passed", [workerId]: "running" } });
    expect(live[0].data.flow).toBe(true);
    const idle = toRfEdges(g, { nodeStates: {} });
    expect(idle[0].data.flow).toBe(false);
  });

  it("degrades to an untyped, non-flowing wire when no graph context is given", () => {
    const edge = { id: "e1", from: { node: "a", port: "out" }, to: { node: "b", port: "in" } };
    expect(toRfEdge(edge)).toMatchObject({ data: { type: "any", flow: false } });
  });
});

describe("rfAdapter — connectionIsValid delegates to canConnect", () => {
  it("accepts a type-compatible connection and matches canConnect's verdict", () => {
    const { g, workerId } = withWorker();
    const conn = { source: "input", sourceHandle: "out", target: workerId, targetHandle: "in" };
    expect(connectionIsValid(g, conn)).toBe(true);
    expect(connectionIsValid(g, conn)).toBe(canConnect(g, { node: "input", port: "out" }, { node: workerId, port: "in" }).ok);
  });

  it("rejects a type-incompatible connection exactly as canConnect does", () => {
    let g = createInitialGraph();
    const t = addNode(g, tallyEntry); g = t.state;
    const m = addNode(g, mapEntry); g = m.state;
    // tally.out is number, map.in is array → not assignable.
    const conn = { source: t.node.id, sourceHandle: "out", target: m.node.id, targetHandle: "in" };
    expect(connectionIsValid(g, conn)).toBe(false);
    expect(connectionIsValid(g, conn)).toBe(canConnect(g, { node: t.node.id, port: "out" }, { node: m.node.id, port: "in" }).ok);
  });

  it("rejects self-edges, duplicate edges, and a missing endpoint", () => {
    let { g, workerId } = withWorker();
    expect(connectionIsValid(g, { source: workerId, sourceHandle: "out", target: workerId, targetHandle: "in" })).toBe(false);
    g = addEdge(g, { node: "input", port: "out" }, { node: workerId, port: "in" }).state;
    expect(connectionIsValid(g, { source: "input", sourceHandle: "out", target: workerId, targetHandle: "in" })).toBe(false); // dupe
    expect(connectionIsValid(g, { source: "input", sourceHandle: "out", target: null, targetHandle: "in" })).toBe(false);
  });
});

describe("rfAdapter — handleReceptivity drives the live receptive/reject glow", () => {
  it("lights compatible inputs receptive while dragging from an output", () => {
    const { g, workerId } = withWorker();
    const source = { nodeId: "input", handleId: "out", handleType: "source" };
    expect(handleReceptivity(g, source, { nodeId: workerId, portName: "in", side: "in" })).toBe("receptive");
  });

  it("marks an incompatible input reject (matching canConnect) while dragging from an output", () => {
    let g = createInitialGraph();
    const t = addNode(g, tallyEntry); g = t.state; // out: number
    const m = addNode(g, mapEntry); g = m.state;   // in: array
    const source = { nodeId: t.node.id, handleId: "out", handleType: "source" };
    expect(handleReceptivity(g, source, { nodeId: m.node.id, portName: "in", side: "in" })).toBe("reject");
  });

  it("ignores same-role handles, the source node's own handles, and a no-drag state", () => {
    const { g, workerId } = withWorker();
    const source = { nodeId: "input", handleId: "out", handleType: "source" };
    // another output (same role as the source) → not a drop target
    expect(handleReceptivity(g, source, { nodeId: workerId, portName: "out", side: "out" })).toBe(null);
    // a handle on the source's own node → not a target
    expect(handleReceptivity(g, source, { nodeId: "input", portName: "out", side: "out" })).toBe(null);
    // no connection in flight
    expect(handleReceptivity(g, null, { nodeId: workerId, portName: "in", side: "in" })).toBe(null);
  });

  it("supports reverse drag: dragging from an input lights compatible outputs receptive", () => {
    const { g, workerId } = withWorker();
    const source = { nodeId: workerId, handleId: "in", handleType: "target" };
    expect(handleReceptivity(g, source, { nodeId: "input", portName: "out", side: "out" })).toBe("receptive");
  });
});
