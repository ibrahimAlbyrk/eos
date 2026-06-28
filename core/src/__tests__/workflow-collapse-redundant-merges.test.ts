import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { wf } from "../workflow/dsl.ts";
import { treeToGraph } from "../workflow/tree-to-graph.ts";
import { collapseRedundantMerges } from "../workflow/collapse-redundant-merges.ts";
import { buildEngine, spawnPort, type SpawnResponse } from "./helpers/workflowFakes.ts";
import {
  WorkflowGraphSchema, WORKFLOW_GRAPH_VERSION, type WorkflowGraph,
} from "../../../contracts/src/workflow-graph.ts";
import type { RunContext } from "../ports/WorkflowEngine.ts";

// collapseRedundantMerges is the pure post-pass that strips treeToGraph's redundant
// phase-ordering merge nodes (the doubled P/G fan) so a converted graph reads as a
// clean single-merge-per-stage pipeline — WITHOUT changing execution. These tests pin
// the transform's structure rules on synthetic graphs AND prove (through the real
// engine, faked spawn) that collapsing the canonical 3→5→2 topology runs identically.

const INPUT = "__input__";
const OUTPUT = "__output__";
const CTX: RunContext = { runId: "run", ownerId: "orch", mode: "acceptEdits" };
const echoNodeId = (spec: { nodeId: string }): SpawnResponse => ({ output: spec.nodeId });

const valid = (g: WorkflowGraph): WorkflowGraph => {
  const parsed = WorkflowGraphSchema.safeParse(g);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  return g;
};
const ids = (g: WorkflowGraph): string[] => g.nodes.map((n) => n.id).sort();
const has = (g: WorkflowGraph, id: string): boolean => g.nodes.some((n) => n.id === id);

// Every node reachable from the input by following edges forward (no orphans).
function connected(g: WorkflowGraph): boolean {
  const out = new Map<string, string[]>();
  for (const n of g.nodes) out.set(n.id, []);
  for (const e of g.edges) out.get(e.from.node)?.push(e.to.node);
  const seen = new Set<string>([INPUT]);
  const stack = [INPUT];
  while (stack.length) for (const nx of out.get(stack.pop()!) ?? []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
  return seen.size === g.nodes.length;
}

// A phase compiled by treeToGraph: workers fan into an ordering merge P (default `in`)
// AND a sibling data merge G (a named glob port) with the SAME inputs; the consumer is
// fed by both. P is the redundant one — G already enforces the dependency as real data.
const doubledFan = (): WorkflowGraph => valid({
  name: "doubled-fan",
  version: WORKFLOW_GRAPH_VERSION,
  nodes: [
    { id: INPUT, kind: "input" },
    { id: "w0", kind: "worker", config: { prompt: "w0" } },
    { id: "w1", kind: "worker", config: { prompt: "w1" } },
    { id: "P", kind: "merge", outputs: [{ name: "out", type: "array" }] },           // ordering only
    { id: "G", kind: "merge", outputs: [{ name: "out", type: "array" }] },           // data source (named port)
    { id: "C", kind: "worker", config: { prompt: "c {{nodes.w-*.output}}" }, inputs: [{ name: "w-*", type: "any" }] },
    { id: OUTPUT, kind: "output", inputs: [{ name: "in", type: "any" }] },
  ],
  edges: [
    { from: { node: INPUT, port: "out" }, to: { node: "w0", port: "in" } },
    { from: { node: INPUT, port: "out" }, to: { node: "w1", port: "in" } },
    { from: { node: "w0", port: "out" }, to: { node: "P", port: "in" } },
    { from: { node: "w1", port: "out" }, to: { node: "P", port: "in" } },
    { from: { node: "w0", port: "out" }, to: { node: "G", port: "in" } },
    { from: { node: "w1", port: "out" }, to: { node: "G", port: "in" } },
    { from: { node: "P", port: "out" }, to: { node: "C", port: "in" } },             // redundant ordering edge
    { from: { node: "G", port: "out" }, to: { node: "C", port: "w-*" } },            // the real data edge
    { from: { node: "C", port: "out" }, to: { node: OUTPUT, port: "in" } },
  ],
});

describe("collapseRedundantMerges — structure", () => {
  it("removes the redundant ordering merge but KEEPS the data-source merge that covers it", () => {
    const out = collapseRedundantMerges(doubledFan());
    assert.ok(!has(out, "P"), "the ordering merge P is removed");
    assert.ok(has(out, "G"), "the data-source merge G is kept");
    assert.deepEqual(ids(out), [INPUT, OUTPUT, "C", "G", "w0", "w1"].sort());
    // C's dependency now flows solely through G's data edge; no edge touches P.
    assert.ok(!out.edges.some((e) => e.from.node === "P" || e.to.node === "P"), "no dangling P edges remain");
    assert.ok(out.edges.some((e) => e.from.node === "G" && e.to.node === "C"), "G still feeds C");
    valid(out);
    assert.ok(connected(out), "graph stays fully connected (no orphans)");
  });

  it("KEEPS a merge that aggregates into the workflow output (the final-stage merge)", () => {
    // input → {a,b} → M → output. M feeds the output node, so it is a real data sink.
    const g = valid({
      name: "final-merge",
      version: WORKFLOW_GRAPH_VERSION,
      nodes: [
        { id: INPUT, kind: "input" },
        { id: "a", kind: "worker", config: { prompt: "a" } },
        { id: "b", kind: "worker", config: { prompt: "b" } },
        { id: "M", kind: "merge", outputs: [{ name: "out", type: "array" }] },
        { id: OUTPUT, kind: "output", inputs: [{ name: "in", type: "any" }] },
      ],
      edges: [
        { from: { node: INPUT, port: "out" }, to: { node: "a", port: "in" } },
        { from: { node: INPUT, port: "out" }, to: { node: "b", port: "in" } },
        { from: { node: "a", port: "out" }, to: { node: "M", port: "in" } },
        { from: { node: "b", port: "out" }, to: { node: "M", port: "in" } },
        { from: { node: "M", port: "out" }, to: { node: OUTPUT, port: "in" } },
      ],
    });
    assert.deepEqual(collapseRedundantMerges(g), g, "a merge feeding the output is never removed");
  });

  it("is a no-op when there is no redundant pattern (only an ordering merge, no covering sibling)", () => {
    // input → {a,b} → P → c → output. P is ordering-only but no sibling merge covers c,
    // so P carries the ONLY dependency and must be kept.
    const g = valid({
      name: "lone-ordering",
      version: WORKFLOW_GRAPH_VERSION,
      nodes: [
        { id: INPUT, kind: "input" },
        { id: "a", kind: "worker", config: { prompt: "a" } },
        { id: "b", kind: "worker", config: { prompt: "b" } },
        { id: "P", kind: "merge", outputs: [{ name: "out", type: "array" }] },
        { id: "c", kind: "worker", config: { prompt: "c" } },
        { id: OUTPUT, kind: "output", inputs: [{ name: "in", type: "any" }] },
      ],
      edges: [
        { from: { node: INPUT, port: "out" }, to: { node: "a", port: "in" } },
        { from: { node: INPUT, port: "out" }, to: { node: "b", port: "in" } },
        { from: { node: "a", port: "out" }, to: { node: "P", port: "in" } },
        { from: { node: "b", port: "out" }, to: { node: "P", port: "in" } },
        { from: { node: "P", port: "out" }, to: { node: "c", port: "in" } },
        { from: { node: "c", port: "out" }, to: { node: OUTPUT, port: "in" } },
      ],
    });
    assert.deepEqual(collapseRedundantMerges(g), g, "an ordering merge with no covering sibling is kept");
  });

  it("is deterministic and idempotent", () => {
    const a = collapseRedundantMerges(doubledFan());
    const b = collapseRedundantMerges(doubledFan());
    assert.deepEqual(a, b, "same graph in → same graph out");
    assert.deepEqual(collapseRedundantMerges(a), a, "a second pass removes nothing more");
  });
});

// ===========================================================================
// EXECUTION UNCHANGED — the canonical 3→5→2 topology through the real engine
// ===========================================================================

describe("collapseRedundantMerges — execution is unchanged (real engine, faked spawn)", () => {
  // The authored research-analysis-planning topology (matches the shipped builtin's
  // generation source). Lowered to a graph, then optionally collapsed, then run.
  const rapTree = () => wf.define("rap", (b) => ({
    root: b.sequence([
      b.phase("research", b.parallel(Array.from({ length: 3 }, (_, i) =>
        b.step({ id: `research-${i}`, prompt: `r${i} {{args.topic}}` })))),
      b.phase("analysis", b.parallel(Array.from({ length: 5 }, (_, i) =>
        b.step({ id: `analysis-${i}`, prompt: `a${i} {{nodes.research-*.output}}` })))),
      b.phase("planning", b.parallel(Array.from({ length: 2 }, (_, i) =>
        b.step({ id: `plan-${i}`, prompt: `p${i} {{nodes.analysis-*.output}}` })))),
    ], "root"),
  }));

  async function runGraph(g: WorkflowGraph) {
    const spawn = spawnPort(echoNodeId);
    const { engine } = buildEngine(spawn); // fresh repos per run (avoids memo replay across runs)
    const res = await engine.run(g, { topic: "X" }, CTX);
    const steps = spawn.calls.steps;
    return {
      res,
      nodeIds: steps.map((s) => s.nodeId).sort(),
      prompts: Object.fromEntries(steps.map((s) => [s.nodeId, s.prompt])),
    };
  }

  it("collapsing removes the 2 redundant ordering merges yet yields the SAME run", async () => {
    const raw = treeToGraph(rapTree());
    const collapsed = collapseRedundantMerges(raw);

    // structural delta: exactly the two phase-ordering merges (research + analysis) go;
    // both glob data merges and the final planning merge stay.
    const merges = (g: WorkflowGraph) => g.nodes.filter((n) => n.kind === "merge").length;
    assert.equal(merges(raw), 5, "raw: 3 parallel ordering merges + 2 glob data merges");
    assert.equal(merges(collapsed), 3, "collapsed: 2 glob merges + the final planning merge");
    assert.equal(raw.nodes.length - collapsed.nodes.length, 2, "exactly 2 merge nodes removed");
    valid(collapsed);

    const before = await runGraph(raw);
    const after = await runGraph(collapsed);

    assert.deepEqual(after.res, before.res, "run output + status identical after collapse");
    assert.deepEqual(after.res.output, ["plan-0", "plan-1"], "still yields the 2 plans");
    assert.equal(after.res.status, "passed");
    assert.deepEqual(after.nodeIds, before.nodeIds, "the same set of workers spawns");
    assert.deepEqual(after.nodeIds, [
      "analysis-0", "analysis-1", "analysis-2", "analysis-3", "analysis-4",
      "plan-0", "plan-1", "research-0", "research-1", "research-2",
    ], "all 10 workers run, none dropped");
    assert.deepEqual(after.prompts, before.prompts, "every worker sees the SAME resolved prompt (data flow unchanged)");
    // the glob data flow is intact: analysis still embeds the full research corpus.
    assert.match(after.prompts["analysis-0"], /research-0/);
    assert.match(after.prompts["analysis-0"], /research-2/);
    assert.match(after.prompts["plan-0"], /analysis-4/);
  });

  it("is a no-op on a topology with no redundant fan (build-with-experts-shaped: plan → forEach → review)", () => {
    const tree = wf.define("bwe", (b) => ({
      root: b.sequence([
        b.step({ id: "plan", prompt: "plan {{args.feature}}" }),
        b.forEach({ id: "impl", over: "{{nodes.plan.output}}", body: b.step({ id: "impl-item", prompt: "do {{item}}" }) }),
        b.step({ id: "review", prompt: "review {{nodes.impl.output}}" }),
      ], "root"),
    }));
    const raw = treeToGraph(tree);
    assert.deepEqual(collapseRedundantMerges(raw), raw, "no parallel/glob doubled fan → nothing to collapse");
  });
});
