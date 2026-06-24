import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BuiltinWorkflowDefinitionSource, BUILTIN_WORKFLOW_DEFINITIONS } from "../index.ts";
import { WorkflowDefinitionSchema, type WorkflowDefinitionRecord } from "../../../contracts/src/workflow.ts";
import type { StepNode, SequenceNode, PhaseNode, ParallelNode, ForEachNode } from "../../../contracts/src/workflow-node.ts";

describe("BuiltinWorkflowDefinitionSource", () => {
  const source = new BuiltinWorkflowDefinitionSource();

  it("lists every builtin tagged source:builtin", () => {
    const records = source.list();
    const names = records.map((r) => r.name).sort();
    assert.deepEqual(names, ["build-with-experts", "research-analysis-planning"]);
    assert.ok(records.every((r) => r.source === "builtin"), "every builtin record is tagged source:builtin");
  });

  it("each builtin parses as a valid WorkflowDefinition", () => {
    for (const def of BUILTIN_WORKFLOW_DEFINITIONS) {
      const res = WorkflowDefinitionSchema.safeParse(def);
      assert.ok(res.success, `${def.name} must parse: ${res.success ? "" : JSON.stringify(res.error.issues)}`);
    }
  });

  it("research-analysis-planning encodes the 3 → 5 → 2 barrier topology (§5.2)", () => {
    const def = BUILTIN_WORKFLOW_DEFINITIONS.find((d) => d.name === "research-analysis-planning")!;
    assert.deepEqual(def.experts, []);
    const root = def.root as SequenceNode;
    assert.equal(root.type, "sequence");
    const [research, analysis, planning] = root.children as PhaseNode[];
    assert.deepEqual([research.label, analysis.label, planning.label], ["research", "analysis", "planning"]);
    const fanOut = (p: PhaseNode) => (p.body as ParallelNode).children as StepNode[];
    assert.equal(fanOut(research).length, 3);
    assert.equal(fanOut(analysis).length, 5);
    assert.equal(fanOut(planning).length, 2);
    // The analysis pass synthesizes the FULL research corpus via the fan-out glob.
    assert.match(fanOut(analysis)[0].prompt, /\{\{nodes\.research-\*\.output\}\}/);
    assert.deepEqual(fanOut(research).map((s) => s.id), ["research-0", "research-1", "research-2"]);
  });

  it("build-with-experts wires a standing expert pool + per-module forEach (§4.5)", () => {
    const def = BUILTIN_WORKFLOW_DEFINITIONS.find((d) => d.name === "build-with-experts")!;
    assert.deepEqual(def.experts?.map((e) => e.id).sort(), ["patterns-expert", "solid-expert"]);
    const root = def.root as SequenceNode;
    const [plan, implement, review] = root.children as [StepNode, PhaseNode, StepNode];
    assert.equal(plan.id, "plan");
    // The fan-out iterates the typed module list from plan's output.
    const forEach = (implement as PhaseNode).body as ForEachNode;
    assert.equal(forEach.type, "forEach");
    assert.equal(forEach.over, "{{nodes.plan.output.modules}}");
    assert.equal((forEach.body as StepNode).id, "impl-item");
    // The barrier review reads the aggregated forEach output.
    assert.match(review.prompt, /\{\{nodes\.impl\.output\}\}/);
  });

  it("is resolvable by name and shadowable (overlay precedence — builtin listed first)", () => {
    // Replicates the container resolver's nearest-wins overlay (last match by name).
    const resolve = (name: string, records: WorkflowDefinitionRecord[]) => {
      let found: WorkflowDefinitionRecord | null = null;
      for (const r of records) if (r.name === name) found = r;
      return found;
    };
    const builtins = source.list();
    assert.equal(resolve("research-analysis-planning", builtins)?.source, "builtin");
    assert.equal(resolve("build-with-experts", builtins)?.source, "builtin");
    assert.equal(resolve("nope", builtins), null);

    // A user/runtime definition of the same name shadows the builtin (it is listed AFTER).
    const userOverride: WorkflowDefinitionRecord = {
      name: "build-with-experts", source: "user",
      root: { type: "step", id: "x", prompt: "p" },
    };
    assert.equal(resolve("build-with-experts", [...builtins, userOverride])?.source, "user");
  });
});
