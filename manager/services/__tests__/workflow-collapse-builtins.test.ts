import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { researchAnalysisPlanning } from "../../workflows/research-analysis-planning.ts";
import { buildWithExperts } from "../../workflows/build-with-experts.ts";
import { collapseRedundantMerges } from "../../../core/src/workflow/collapse-redundant-merges.ts";
import { buildEngine, spawnPort, type SpawnResponse } from "../../../core/src/__tests__/helpers/workflowFakes.ts";
import { WorkflowGraphSchema, type WorkflowGraph } from "../../../contracts/src/workflow-graph.ts";
import type { RunContext } from "../../../core/src/ports/WorkflowEngine.ts";

// The shipped builtins are layoutGraph(collapseRedundantMerges(treeToGraph(tree))). These
// tests pin the OPERATOR-visible result: each stage shows ONE merge (a clean
// input→3→1→5→1→2→1→output pipeline, no doubled all-to-all fan), the graphs stay
// schema-valid + fully connected, and — the critical guarantee — they still execute to
// the same answer through the real engine (faked spawn): the 2 plans / the review.

const INPUT = "__input__";
const CTX: RunContext = { runId: "run", ownerId: "orch", mode: "acceptEdits" };

// Schema-conforming structured outputs (each builtin step declares an outputSchema the
// engine validates against), keyed by node id (loop-body ids are scoped, e.g. impl-item#0).
const respond = (spec: { nodeId: string }): SpawnResponse => {
  const id = spec.nodeId;
  if (id.startsWith("research-")) return { output: { summary: `summary-${id}` } };
  if (id.startsWith("analysis-")) return { output: { analysis: `analysis-${id}` } };
  if (id.startsWith("plan-")) return { output: { plan: id } };           // research-analysis-planning: plan-0 / plan-1
  if (id === "plan") return { output: { modules: ["mod-a", "mod-b"] } };  // build-with-experts: the planner
  if (id.startsWith("impl-item")) return { output: { module: id, status: "ok" } };
  if (id === "review") return { output: { verdict: "ok" } };
  return {};
};

function builtin(name: string): WorkflowGraph {
  const g = name === "research-analysis-planning" ? researchAnalysisPlanning : buildWithExperts;
  const parsed = WorkflowGraphSchema.safeParse(g);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  return g as WorkflowGraph;
}

// Every node reachable from the input by following edges forward.
function connected(g: WorkflowGraph): boolean {
  const out = new Map<string, string[]>();
  for (const n of g.nodes) out.set(n.id, []);
  for (const e of g.edges) out.get(e.from.node)?.push(e.to.node);
  const seen = new Set<string>([INPUT]);
  const stack = [INPUT];
  while (stack.length) for (const nx of out.get(stack.pop()!) ?? []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
  return seen.size === g.nodes.length;
}

// The laid-out column histogram (node count per distinct ui.x, left→right) — exactly
// what the operator sees as stages in the editor.
function columnCounts(g: WorkflowGraph): number[] {
  const byX = new Map<number, number>();
  for (const n of g.nodes) byX.set(n.ui!.x, (byX.get(n.ui!.x) ?? 0) + 1);
  return [...byX.keys()].sort((a, b) => a - b).map((x) => byX.get(x)!);
}

const mergeCount = (g: WorkflowGraph) => g.nodes.filter((n) => n.kind === "merge").length;

describe("shipped builtins — collapsed to one merge per stage (operator-visible shape)", () => {
  it("research-analysis-planning reads as a clean input→3→1→5→1→2→1→output pipeline", () => {
    const g = builtin("research-analysis-planning");
    assert.deepEqual(columnCounts(g), [1, 3, 1, 5, 1, 2, 1, 1], "one merge per stage, no doubled fan");
    assert.equal(mergeCount(g), 3, "exactly the 2 glob merges + the final planning merge");
    assert.ok(connected(g), "fully connected, no orphans");
    assert.deepEqual(collapseRedundantMerges(g), g, "already collapsed — idempotent on the shipped graph");
  });

  it("build-with-experts reads as a clean plan→impl→review pipeline (no merges to collapse)", () => {
    const g = builtin("build-with-experts");
    assert.deepEqual(columnCounts(g), [1, 1, 1, 1, 1], "input → plan → impl(loop) → review → output");
    assert.equal(mergeCount(g), 0, "no parallel/glob fan, so no merges");
    assert.ok(connected(g), "fully connected, no orphans");
    assert.deepEqual(collapseRedundantMerges(g), g, "nothing to collapse — idempotent");
  });
});

describe("shipped builtins — execution unchanged (real engine, faked spawn)", () => {
  it("research-analysis-planning completes its 10 steps and yields the 2 plans", async () => {
    const spawn = spawnPort(respond);
    const { engine } = buildEngine(spawn);
    const res = await engine.run(builtin("research-analysis-planning"), { topic: "X" }, CTX);

    assert.equal(res.status, "passed");
    assert.deepEqual(res.output, [{ plan: "plan-0" }, { plan: "plan-1" }], "the workflow output is the 2 synthesized plans");
    assert.deepEqual(
      spawn.calls.steps.map((s) => s.nodeId).sort(),
      ["analysis-0", "analysis-1", "analysis-2", "analysis-3", "analysis-4", "plan-0", "plan-1", "research-0", "research-1", "research-2"],
      "all 10 workers ran, none dropped",
    );
    // the glob data flow survived the collapse: analysis embeds the full research corpus.
    const a0 = spawn.calls.steps.find((s) => s.nodeId === "analysis-0")!;
    assert.match(a0.prompt, /summary-research-0/);
    assert.match(a0.prompt, /summary-research-2/);
  });

  it("build-with-experts spawns its expert pool, implements each module, and yields the review", async () => {
    const spawn = spawnPort(respond);
    const { engine } = buildEngine(spawn);
    const res = await engine.run(builtin("build-with-experts"), { feature: "F" }, CTX);

    assert.equal(res.status, "passed");
    assert.deepEqual(res.output, { verdict: "ok" }, "the workflow output is the reviewer's verdict");
    assert.deepEqual(spawn.calls.experts.map((e) => e.name).sort(), ["patterns-expert", "solid-expert"], "standing expert pool spawned");
    assert.deepEqual(
      spawn.calls.steps.map((s) => s.nodeId).sort(),
      ["impl-item#0", "impl-item#1", "plan", "review"],
      "plan → one implementer per planned module → review",
    );
  });
});
