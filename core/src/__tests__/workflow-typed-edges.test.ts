import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildEngine, spawnPort, type SpawnResponse } from "./helpers/workflowFakes.ts";
import { WorkflowGraphSchema, WORKFLOW_GRAPH_VERSION, type WorkflowGraph } from "../../../contracts/src/workflow-graph.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";
import type { RunContext } from "../ports/WorkflowEngine.ts";

// Phase 3 proof tests: typed VALUES flow port→port on the edges of a hand-authored
// v2 graph at RUNTIME — a worker node receives an upstream output as a STRUCTURED
// input (not a scraped `{{nodes.id}}` string), a glue node consumes a typed input
// port as its fn argument, a delivered value of the wrong type fails the node with a
// precise error, and a v1 tree's string-binding path keeps producing identical
// results (back-compat, non-negotiable).

const CTX: RunContext = { runId: "run", ownerId: "orch", mode: "acceptEdits" };

// Assert a hand-authored graph passes the v2 structural + edge-type-compat contract,
// and run the PARSED graph (port defaults out/in applied) — exactly what a real v2
// acceptance path hands the scheduler.
function valid(g: WorkflowGraph): WorkflowGraph {
  const parsed = WorkflowGraphSchema.safeParse(g);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  return parsed.success ? parsed.data : g;
}

// ===========================================================================
// WORKER NODE RECEIVES A TYPED VALUE ON AN EDGE (not a string ref)
// ===========================================================================

describe("typed edges — a worker node receives an upstream output as a typed input port", () => {
  const PAYLOAD = { score: 42, label: "ok", tags: ["x", "y"] };

  // input → A (emits a json object) → B. The edge A.out → B.research delivers A's
  // OBJECT value to B's named input port; B authors `{{in.research}}` to interpolate
  // it. No `{{nodes.A.output}}` cross-node string ref anywhere.
  const graph = (): WorkflowGraph => valid({
    name: "typed-worker",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "A", kind: "worker", config: { prompt: "produce" }, outputs: [{ name: "out", type: "json" }] },
      { id: "B", kind: "worker", config: { prompt: "consume {{in.research}}" }, inputs: [{ name: "research", type: "object" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "A", port: "in" } },
      { from: { node: "A", port: "out" }, to: { node: "B", port: "research" } },
      { from: { node: "B", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("delivers the structured value to the worker's spawn spec AND interpolates {{in.research}}", async () => {
    const spawn = spawnPort((spec): SpawnResponse =>
      spec.nodeId === "A" ? { output: PAYLOAD } : { output: "done" });
    const { engine } = buildEngine(spawn);
    const res = await engine.run(graph(), {}, CTX);

    const b = spawn.calls.steps.find((s) => s.nodeId === "B")!;
    assert.deepEqual(b.inputs?.research, PAYLOAD, "B received A's object on its input port — a typed value, via the edge");
    assert.equal(typeof b.inputs?.research, "object", "delivered structurally, not as a JSON string");
    assert.match(b.prompt, /"score":42/, "{{in.research}} interpolated the same value into the prompt (intra-node)");
    assert.equal(res.status, "passed");
  });
});

// ===========================================================================
// GLUE NODE CONSUMES A TYPED INPUT PORT
// ===========================================================================

describe("typed edges — a glue node consumes a typed input port as its fn argument", () => {
  // input → A (emits an array with duplicates) → G (dedup over `{{in.data}}`). The
  // dedup fn receives the REAL array off the edge (not a re-parsed string), so it
  // returns the de-duplicated list.
  const graph = (): WorkflowGraph => valid({
    name: "typed-glue",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "A", kind: "worker", config: { prompt: "produce" }, outputs: [{ name: "out", type: "array" }] },
      { id: "G", kind: "dedup", config: { over: "{{in.data}}" }, inputs: [{ name: "data", type: "array" }], outputs: [{ name: "out", type: "array" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in" }, to: { node: "A" } },
      { from: { node: "A", port: "out" }, to: { node: "G", port: "data" } },
      { from: { node: "G", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("the dedup fn folds the typed array delivered on the input port", async () => {
    const spawn = spawnPort((spec): SpawnResponse => (spec.nodeId === "A" ? { output: [1, 1, 2, 3, 3] } : {}));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(graph(), {}, CTX);

    assert.deepEqual(res.output, [1, 2, 3], "the glue consumed the typed array off its input port");
    assert.equal(res.status, "passed");
  });
});

// ===========================================================================
// RUNTIME PORT-TYPE MISMATCH FAILS THE NODE
// ===========================================================================

describe("typed edges — a delivered value of the wrong type fails the node with a precise error", () => {
  // A.out is `any`, so the edge to B's `number` port is authoring-compatible; at
  // RUNTIME A emits a string, which the scheduler rejects against B's declared port.
  const graph = (): WorkflowGraph => valid({
    name: "type-mismatch",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "A", kind: "worker", config: { prompt: "produce" }, outputs: [{ name: "out", type: "any" }] },
      { id: "B", kind: "worker", config: { prompt: "consume {{in.count}}" }, inputs: [{ name: "count", type: "number" }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in" }, to: { node: "A" } },
      { from: { node: "A", port: "out" }, to: { node: "B", port: "count" } },
      { from: { node: "B", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("fails the node before it spawns, naming the port and the expected/actual types", async () => {
    const spawn = spawnPort((spec): SpawnResponse => (spec.nodeId === "A" ? { output: "hello" } : {}));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(graph(), {}, CTX);

    assert.equal(res.status, "failed");
    assert.match(String(res.output), /node "B" input port "count" expected number, got string/);
    assert.ok(!spawn.calls.steps.some((s) => s.nodeId === "B"), "the mis-typed node never spawned a worker");
  });
});

// ===========================================================================
// BACK-COMPAT — v1 TREE STRING-BINDING UNCHANGED
// ===========================================================================

describe("typed edges — a v1 tree's string-binding path produces identical results", () => {
  // The legacy `{{nodes.<id>.output}}` cross-node ref (compiled by treeToGraph) must
  // keep flowing data exactly as before; typed edges are additive, never a swap.
  const tree = (): WorkflowDefinition => ({
    name: "v1-string-binding",
    root: {
      type: "sequence", id: "root", children: [
        { type: "step", id: "s1", prompt: "first {{args.topic}}" },
        { type: "step", id: "s2", prompt: "second saw: {{nodes.s1.output}}" },
      ],
    },
  } as unknown as WorkflowDefinition);

  it("s2 still receives s1's output via the string ref, and the run output is unchanged", async () => {
    const spawn = spawnPort(); // echo the (binding-resolved) prompt as each step's output
    const { engine } = buildEngine(spawn);
    const res = await engine.run(tree(), { topic: "X" }, CTX);

    const s2 = spawn.calls.steps.find((s) => s.nodeId === "s2")!;
    assert.equal(s2.prompt, "second saw: first X", "v1 cross-node string binding flows unchanged");
    assert.equal(res.output, "second saw: first X", "the run output matches the v1 tree-walk result");
    assert.equal(res.status, "passed");
  });
});
