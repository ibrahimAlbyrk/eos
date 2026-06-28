import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { layoutGraph } from "../../workflows/layout.ts";
import { BUILTIN_WORKFLOW_DEFINITIONS } from "../../workflows/index.ts";
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraph, type GraphNode } from "../../../contracts/src/workflow-graph.ts";

// Layout is what makes a converted (treeToGraph) builtin open read-only in the editor:
// every node needs an explicit ui.{x,y}, the result must read as ONE connected
// left→right pipeline, and nothing may overlap. These assertions pin those properties
// for the shipped builtins AND for the general layout contract on a synthetic graph,
// so the layout stays good for any future converted graph, not just these two.

const INPUT = "__input__";

// Node-card metrics mirror app/ui sceneModel.js (the renderer's source of truth) so the
// overlap check uses the SAME boxes the editor paints.
const NODE_W = 184, HEADER_H = 30, ROW_H = 22, ROW_PAD = 6;
function nodeBox(n: GraphNode): { x: number; y: number; w: number; h: number } {
  const rows = Math.max((n.inputs ?? []).length, (n.outputs ?? []).length, 1);
  return { x: n.ui!.x, y: n.ui!.y, w: NODE_W, h: HEADER_H + ROW_PAD * 2 + rows * ROW_H };
}
function overlaps(a: ReturnType<typeof nodeBox>, b: ReturnType<typeof nodeBox>): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Every node reachable from the input by following edges forward (no orphans).
function reachableFromInput(g: WorkflowGraph): Set<string> {
  const out = new Map<string, string[]>();
  for (const n of g.nodes) out.set(n.id, []);
  for (const e of g.edges) out.get(e.from.node)?.push(e.to.node);
  const seen = new Set<string>([INPUT]);
  const stack = [INPUT];
  while (stack.length) {
    for (const nx of out.get(stack.pop()!) ?? []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
  }
  return seen;
}

function builtin(name: string): WorkflowGraph {
  return BUILTIN_WORKFLOW_DEFINITIONS.find((d) => d.name === name)! as WorkflowGraph;
}

// Assert the structural-legibility invariants on any laid-out graph (recurses into
// loop bodies, which are themselves laid-out sub-graphs).
function assertWellLaidOut(g: WorkflowGraph, label: string): void {
  assert.ok(g.nodes.every((n) => typeof n.ui?.x === "number" && typeof n.ui?.y === "number"),
    `${label}: every node has a ui coordinate`);

  // single connected pipeline — every node reachable from the input, no orphans
  const reachable = reachableFromInput(g);
  assert.equal(reachable.size, g.nodes.length, `${label}: every node reachable from input (orphans: ${g.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id).join(",")})`);

  // no two node cards overlap
  const boxes = g.nodes.map((n) => ({ id: n.id, box: nodeBox(n) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(!overlaps(boxes[i].box, boxes[j].box), `${label}: ${boxes[i].id} overlaps ${boxes[j].id}`);
    }
  }

  // every edge points strictly rightward (layered columns ⇒ flow reads left→right)
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const e of g.edges) {
    const f = byId.get(e.from.node)!, t = byId.get(e.to.node)!;
    assert.ok(f.ui!.x < t.ui!.x, `${label}: edge ${e.from.node}→${e.to.node} is not rightward`);
  }

  for (const n of g.nodes) {
    const body = (n.config as { body?: unknown } | undefined)?.body;
    if (n.kind === "loop" && body && typeof body === "object" && Array.isArray((body as WorkflowGraph).nodes)) {
      assertWellLaidOut(body as WorkflowGraph, `${label}/${n.id}.body`);
    }
  }
}

describe("layoutGraph — converted builtins read as one connected pipeline", () => {
  for (const name of ["research-analysis-planning", "build-with-experts"]) {
    it(`${name}: connected, non-overlapping, left→right (recursing loop bodies)`, () => {
      assertWellLaidOut(builtin(name), name);
    });
  }

  it("is pure + deterministic — same graph in, same coordinates out", () => {
    const g = builtin("research-analysis-planning");
    const a = layoutGraph(g);
    const b = layoutGraph(g);
    assert.deepEqual(a.nodes.map((n) => n.ui), b.nodes.map((n) => n.ui));
  });

  it("places a fan-in node on the centroid of its predecessors (barycenter, not insertion-order centering)", () => {
    // input → {a,b,c} → merge → output. The merge must land at the mean row of a,b,c,
    // and a,b,c must straddle the input — the property that keeps a multi-stage flow on
    // one centerline. Asserted on a synthetic graph so it is a general guarantee, not
    // tuned to a builtin's symmetry.
    const node = (id: string, kind: string): GraphNode => ({ id, kind });
    const edge = (from: string, to: string) => ({ from: { node: from, port: "out" }, to: { node: to, port: "in" } });
    const g: WorkflowGraph = {
      name: "fan", version: WORKFLOW_GRAPH_VERSION,
      nodes: [node(INPUT, "input"), node("a", "worker"), node("b", "worker"), node("c", "worker"), node("m", "merge"), node("__output__", "output")],
      edges: [edge(INPUT, "a"), edge(INPUT, "b"), edge(INPUT, "c"), edge("a", "m"), edge("b", "m"), edge("c", "m"), edge("m", "__output__")],
    };
    const laid = layoutGraph(g);
    const y = (id: string) => laid.nodes.find((n) => n.id === id)!.ui!.y;
    const centroidABC = (y("a") + y("b") + y("c")) / 3;
    assert.equal(y("m"), centroidABC, "merge sits on the centroid of a,b,c");
    assert.equal(centroidABC, y(INPUT), "the fan-out straddles its source");
    assert.equal(y("m"), y("__output__"), "the spine stays on one centerline");
  });
});
