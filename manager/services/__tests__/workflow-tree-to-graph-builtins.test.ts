import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_WORKFLOW_DEFINITIONS } from "../../workflows/index.ts";
import { treeToGraph } from "../../../core/src/workflow/tree-to-graph.ts";
import { WorkflowGraphSchema, type WorkflowGraph } from "../../../contracts/src/workflow-graph.ts";

// Golden test (design Phase 1): the two shipped builtins must lower into faithful,
// schema-valid v2 graphs. This pins the compiler against the real authored trees,
// not DSL replicas.

const INPUT = "__input__";
const OUTPUT = "__output__";

function builtin(name: string): WorkflowGraph {
  const def = BUILTIN_WORKFLOW_DEFINITIONS.find((d) => d.name === name)!;
  const g = treeToGraph(def);
  const parsed = WorkflowGraphSchema.safeParse(g);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  return g;
}

function workerIds(g: WorkflowGraph): string[] {
  return g.nodes.filter((n) => n.kind === "worker").map((n) => n.id).sort();
}
function hasEdge(g: WorkflowGraph, fn: string, fp: string, tn: string, tp: string): boolean {
  return g.edges.some((e) => e.from.node === fn && e.from.port === fp && e.to.node === tn && e.to.port === tp);
}
function sourcesInto(g: WorkflowGraph, toNode: string): string[] {
  return g.edges.filter((e) => e.to.node === toNode).map((e) => e.from.node);
}

describe("treeToGraph — builtins compile faithfully (golden)", () => {
  it("both builtins compile to schema-valid graphs with exactly one input/output", () => {
    for (const name of ["research-analysis-planning", "build-with-experts"]) {
      const g = builtin(name);
      assert.equal(g.nodes.filter((n) => n.kind === "input").length, 1);
      assert.equal(g.nodes.filter((n) => n.kind === "output").length, 1);
      assert.equal(g.version, 2);
    }
  });

  it("research-analysis-planning: 3→5→2 fan-out with deterministic glob fan-in", () => {
    const g = builtin("research-analysis-planning");
    // every leaf worker survives, none dropped
    assert.deepEqual(workerIds(g), [
      "analysis-0", "analysis-1", "analysis-2", "analysis-3", "analysis-4",
      "plan-0", "plan-1",
      "research-0", "research-1", "research-2",
    ]);
    // the research corpus glob re-converges into one merge, sorted
    assert.deepEqual(sourcesInto(g, "__glob__:research-*"), ["research-0", "research-1", "research-2"]);
    assert.deepEqual(sourcesInto(g, "__glob__:analysis-*"), ["analysis-0", "analysis-1", "analysis-2", "analysis-3", "analysis-4"]);
    // each analysis pass consumes the full research corpus; each plan the analyses
    assert.ok(hasEdge(g, "__glob__:research-*", "out", "analysis-0", "research-*"));
    assert.ok(hasEdge(g, "__glob__:analysis-*", "out", "plan-0", "analysis-*"));
    // research seeds from the run args (topic)
    assert.ok(hasEdge(g, INPUT, "out", "research-0", "args"));
  });

  it("build-with-experts: plan → forEach loop → review, experts preserved", () => {
    const g = builtin("build-with-experts");
    assert.deepEqual(g.experts?.map((e) => e.id).sort(), ["patterns-expert", "solid-expert"]);
    assert.equal(g.nodes.find((n) => n.id === "plan")?.kind, "worker");
    assert.equal(g.nodes.find((n) => n.id === "impl")?.kind, "loop");
    assert.equal(g.nodes.find((n) => n.id === "review")?.kind, "worker");
    // the forEach iterates plan's typed module list, review aggregates the forEach
    assert.ok(hasEdge(g, "plan", "out", "impl", "plan"), "forEach over {{nodes.plan.output.modules}}");
    assert.ok(hasEdge(g, "impl", "out", "review", "impl"), "review reads {{nodes.impl.output}}");
    assert.ok(hasEdge(g, "review", "out", OUTPUT, "in"));
    // the loop body is itself a valid sub-graph that reads {{item}}
    const body = (g.nodes.find((n) => n.id === "impl")?.config as { body: unknown }).body;
    const parsedBody = WorkflowGraphSchema.safeParse(body);
    assert.ok(parsedBody.success, parsedBody.success ? "" : JSON.stringify(parsedBody.error.issues));
    const bodyGraph = body as WorkflowGraph;
    assert.ok(hasEdge(bodyGraph, INPUT, "item", "impl-item", "item"));
  });
});
