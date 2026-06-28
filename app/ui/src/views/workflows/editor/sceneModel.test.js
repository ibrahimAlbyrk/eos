import { describe, it, expect } from "vitest";
import {
  toScene,
  nodeHeight,
  nodesBounds,
  reconnectPoints,
  NODE_W,
  HEADER_H,
  ROW_H,
  ROW_PAD,
} from "./sceneModel.js";
import { createInitialGraph, addNode, addEdge } from "./graphModel.js";

const workerEntry = { kind: "worker", label: "Worker", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] };
const mergeEntry = { kind: "merge", label: "Merge", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] };
const tallyEntry = { kind: "tally", label: "Tally", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "number" }] };
const twoInEntry = { kind: "worker", label: "TwoIn", inputs: [{ name: "a", type: "any" }, { name: "b", type: "any" }], outputs: [{ name: "out", type: "any" }] };

function sceneNode(scene, id) {
  return scene.nodes.find((n) => n.id === id);
}

describe("sceneModel — node boxes mirror the rendered node layout", () => {
  it("computes box {x,y,w,h} from ui.{x,y} and the fixed metrics", () => {
    const g = createInitialGraph(); // input @ (80,160), output @ (560,160)
    const scene = toScene(g);
    // input: 0 inputs, 1 output → 1 row.
    expect(sceneNode(scene, "input").box).toEqual({
      x: 80, y: 160, w: NODE_W, h: HEADER_H + ROW_PAD * 2 + 1 * ROW_H,
    });
    expect(sceneNode(scene, "output").box.w).toBe(184);
  });

  it("nodeHeight grows with the taller port column (min 1 row)", () => {
    expect(nodeHeight({ inputs: [], outputs: [] })).toBe(HEADER_H + ROW_PAD * 2 + ROW_H);
    expect(nodeHeight({ inputs: [{ name: "a" }, { name: "b" }], outputs: [{ name: "o" }] }))
      .toBe(HEADER_H + ROW_PAD * 2 + 2 * ROW_H);
  });

  it("carries label, kind, status and theming data", () => {
    let g = createInitialGraph();
    const w = addNode(g, workerEntry, { x: 300, y: 300 }); g = w.state;
    const scene = toScene(g, { nodeStates: { [w.node.id]: "running" } });
    const n = sceneNode(scene, w.node.id);
    expect(n).toMatchObject({ kind: "worker", label: "Worker", status: "running", category: "compute", accentVar: "--wfk-compute" });
    expect(sceneNode(scene, "input").status).toBe(null);
  });
});

describe("sceneModel — port anchors sit where the live handles do", () => {
  it("puts inputs on the left edge, outputs on the right edge, centered per row", () => {
    const g = createInitialGraph();
    const scene = toScene(g);
    const out = sceneNode(scene, "input").ports.find((p) => p.side === "out" && p.name === "out");
    // input @ (80,160): out handle on right edge, row 0 center.
    expect(out.anchor).toEqual({ x: 80 + NODE_W, y: 160 + HEADER_H + ROW_PAD + ROW_H / 2 });

    const inp = sceneNode(scene, "output").ports.find((p) => p.side === "in" && p.name === "in");
    // output @ (560,160): in handle on left edge.
    expect(inp.anchor).toEqual({ x: 560, y: 160 + HEADER_H + ROW_PAD + ROW_H / 2 });
  });

  it("stacks a second input row by ROW_H", () => {
    let g = createInitialGraph();
    const n = addNode(g, twoInEntry, { x: 300, y: 100 }); g = n.state;
    const ports = sceneNode(toScene(g), n.node.id).ports;
    const a = ports.find((p) => p.name === "a");
    const b = ports.find((p) => p.name === "b");
    expect(a.anchor).toEqual({ x: 300, y: 100 + HEADER_H + ROW_PAD + ROW_H / 2 });
    expect(b.anchor).toEqual({ x: 300, y: 100 + HEADER_H + ROW_PAD + ROW_H + ROW_H / 2 });
  });
});

describe("sceneModel — edge bezier reproduces getBezierPath", () => {
  it("control points: c1 = start + 0.5*dx, c2 = end - 0.5*dx for a left→right edge", () => {
    let g = createInitialGraph();
    g = addEdge(g, { node: "input", port: "out" }, { node: "output", port: "in" }).state;
    const [edge] = toScene(g).edges;
    // input.out @ (264,207) → output.in @ (560,207); dx=296, off=148.
    expect(edge.path.start).toEqual({ x: 264, y: 207 });
    expect(edge.path.end).toEqual({ x: 560, y: 207 });
    expect(edge.path.c1).toEqual({ x: 412, y: 207 });
    expect(edge.path.c2).toEqual({ x: 412, y: 207 });
    expect(edge.path.d).toBe("M264,207 C412,207 412,207 560,207");
  });

  it("carries the typed-wire hue and run-flow flag (reusing connectionRules helpers)", () => {
    let g = createInitialGraph();
    const t = addNode(g, tallyEntry, { x: 300, y: 300 }); g = t.state;
    g = addEdge(g, { node: t.node.id, port: "out" }, { node: "output", port: "in" }).state;
    const live = toScene(g, { nodeStates: { [t.node.id]: "passed", output: "running" } }).edges[0];
    expect(live.type).toBe("number");
    expect(live.flow).toBe(true);
    const idle = toScene(g).edges[0];
    expect(idle.flow).toBe(false);
  });
});

describe("sceneModel — reconnectPoints (grab handles sit exactly on the endpoints)", () => {
  it("returns the source out-anchor and target in-anchor, with NO offset", () => {
    let g = createInitialGraph();
    g = addEdge(g, { node: "input", port: "out" }, { node: "output", port: "in" }).state;
    const [edge] = toScene(g).edges;
    const pts = reconnectPoints(edge);
    // The handle points must coincide with the wire endpoints (the port anchors).
    expect(pts.source).toEqual(edge.path.start);
    expect(pts.target).toEqual(edge.path.end);
  });

  it("stays on the ports for a NON-horizontal edge (the case the X-offset broke)", () => {
    // Source below-right, target above-left → the edge runs up-and-left, so any
    // ±x offset would slide a handle off its port (the operator's screenshot).
    let g = createInitialGraph();
    const src = addNode(g, workerEntry, { x: 500, y: 600 }); g = src.state;
    const dst = addNode(g, tallyEntry, { x: 200, y: 100 }); g = dst.state;
    g = addEdge(g, { node: src.node.id, port: "out" }, { node: dst.node.id, port: "in" }).state;
    const edge = toScene(g).edges[0];

    const scene = toScene(g);
    const srcOut = sceneNode(scene, src.node.id).ports.find((p) => p.side === "out" && p.name === "out").anchor;
    const dstIn = sceneNode(scene, dst.node.id).ports.find((p) => p.side === "in" && p.name === "in").anchor;

    const pts = reconnectPoints(edge);
    expect(pts.source).toEqual(srcOut);
    expect(pts.target).toEqual(dstIn);
    // out anchor is on the source's right edge; in anchor on the target's left edge.
    expect(pts.source.x).toBe(500 + NODE_W);
    expect(pts.target.x).toBe(200);
  });

  it("is null for an edge without a resolved path", () => {
    expect(reconnectPoints({ id: "e-x" })).toBe(null);
    expect(reconnectPoints(null)).toBe(null);
  });
});

describe("sceneModel — nodesBounds (content extent for fitView / minimap)", () => {
  it("unions every node box; input @ (80,160) + output @ (560,160), each 184x64", () => {
    const h = HEADER_H + ROW_PAD * 2 + ROW_H; // 64
    expect(nodesBounds(toScene(createInitialGraph()).nodes))
      .toEqual({ x: 80, y: 160, w: 560 + NODE_W - 80, h });
  });

  it("is null when there are no boxed nodes", () => {
    expect(nodesBounds([])).toBe(null);
    expect(nodesBounds([{ id: "x" }])).toBe(null);
  });
});

describe("sceneModel — implicit default ports (treeToGraph fan-in merges)", () => {
  // treeToGraph emits glob/parallel fan-in merges whose inbound edges target the
  // IMPLICIT `in` port without declaring it (workflow-graph.ts). The renderer must
  // materialize that port so the wires have an anchor — else a merge renders with no
  // inputs and its incoming edges silently vanish (the operator's screenshot).
  const undeclaredMerge = {
    name: "g", version: 2,
    nodes: [
      { id: "input", kind: "input", inputs: [], outputs: [{ name: "out", type: "any" }], ui: { x: 80, y: 80 } },
      { id: "src", kind: "worker", inputs: [], outputs: [{ name: "out", type: "any" }], ui: { x: 380, y: 80 } },
      // a merge with NO declared inputs, fed via the implicit `in` port
      { id: "merge", kind: "merge", outputs: [{ name: "out", type: "array" }], ui: { x: 680, y: 80 } },
      { id: "output", kind: "output", inputs: [{ name: "in", type: "any" }], outputs: [], ui: { x: 980, y: 80 } },
    ],
    edges: [
      { id: "e1", from: { node: "input", port: "out" }, to: { node: "src", port: "in" } },
      { id: "e2", from: { node: "src", port: "out" }, to: { node: "merge", port: "in" } },
      { id: "e3", from: { node: "merge", port: "out" }, to: { node: "output", port: "in" } },
    ],
  };

  it("materializes the implicit `in` port so the merge shows an input handle", () => {
    const merge = sceneNode(toScene(undeclaredMerge), "merge");
    const inPort = merge.ports.find((p) => p.side === "in" && p.name === "in");
    expect(inPort).toBeDefined();
    expect(inPort.anchor).toEqual({ x: 680, y: 80 + HEADER_H + ROW_PAD + ROW_H / 2 });
  });

  it("resolves the inbound edge path so it actually draws (was null → vanished)", () => {
    const edge = toScene(undeclaredMerge).edges.find((e) => e.id === "e2");
    expect(edge.path).not.toBe(null);
    expect(edge.path.end).toEqual({ x: 680, y: 80 + HEADER_H + ROW_PAD + ROW_H / 2 });
  });

  it("materializes an implicit `in` alongside a declared data port (no clobber)", () => {
    // analysis-style node: a declared `research-*` data port AND an ordering edge on `in`.
    const g = {
      name: "g", version: 2,
      nodes: [
        { id: "input", kind: "input", inputs: [], outputs: [{ name: "out", type: "any" }], ui: { x: 80, y: 80 } },
        { id: "a", kind: "worker", inputs: [{ name: "research-*", type: "any" }], outputs: [{ name: "out", type: "any" }], ui: { x: 380, y: 80 } },
        { id: "output", kind: "output", inputs: [{ name: "in", type: "any" }], outputs: [], ui: { x: 680, y: 80 } },
      ],
      edges: [
        { id: "d", from: { node: "input", port: "out" }, to: { node: "a", port: "research-*" } },
        { id: "o", from: { node: "input", port: "out" }, to: { node: "a", port: "in" } },
        { id: "z", from: { node: "a", port: "out" }, to: { node: "output", port: "in" } },
      ],
    };
    const scene = toScene(g);
    const a = sceneNode(scene, "a");
    const data = a.ports.find((p) => p.side === "in" && p.name === "research-*");
    const ordering = a.ports.find((p) => p.side === "in" && p.name === "in");
    expect(data).toBeDefined();
    expect(ordering).toBeDefined();
    // declared data port keeps row 0; the synthetic `in` is appended at row 1.
    expect(data.anchor.y).toBe(80 + HEADER_H + ROW_PAD + ROW_H / 2);
    expect(ordering.anchor.y).toBe(80 + HEADER_H + ROW_PAD + ROW_H + ROW_H / 2);
    // both inbound edges now resolve a path.
    expect(scene.edges.find((e) => e.id === "d").path).not.toBe(null);
    expect(scene.edges.find((e) => e.id === "o").path).not.toBe(null);
  });
});

describe("sceneModel — fan-in (two edges into one input port)", () => {
  it("routes both edges to the same merge input anchor", () => {
    let g = createInitialGraph();
    const w = addNode(g, workerEntry, { x: 300, y: 300 }); g = w.state;
    const m = addNode(g, mergeEntry, { x: 600, y: 400 }); g = m.state;
    // merge `in` accumulates, so both edges persist (fan-in).
    g = addEdge(g, { node: "input", port: "out" }, { node: m.node.id, port: "in" }).state;
    g = addEdge(g, { node: w.node.id, port: "out" }, { node: m.node.id, port: "in" }).state;

    const scene = toScene(g);
    const intoMerge = scene.edges.filter((e) => e.to.node === m.node.id && e.to.port === "in");
    expect(intoMerge).toHaveLength(2);

    const mergeIn = sceneNode(scene, m.node.id).ports.find((p) => p.side === "in" && p.name === "in").anchor;
    expect(mergeIn).toEqual({ x: 600, y: 400 + HEADER_H + ROW_PAD + ROW_H / 2 });
    for (const e of intoMerge) {
      expect(e.path.end).toEqual(mergeIn);
    }
    // ...and they start from their two distinct sources.
    expect(intoMerge.map((e) => e.from.node).sort()).toEqual(["input", w.node.id].sort());
  });
});
