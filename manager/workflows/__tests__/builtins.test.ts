import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BuiltinWorkflowDefinitionSource, BUILTIN_WORKFLOW_DEFINITIONS } from "../index.ts";
import {
  WorkflowGraphSchema, type AnyWorkflowDefinitionRecord,
} from "../../../contracts/src/workflow-graph.ts";
import type { GraphNode } from "../../../contracts/src/workflow-graph.ts";

const workerIdsWithPrefix = (nodes: GraphNode[], prefix: string) =>
  nodes.filter((n) => n.kind === "worker" && n.id.startsWith(prefix)).map((n) => n.id).sort();
const promptOf = (node: GraphNode | undefined) => (node?.config as { prompt?: string } | undefined)?.prompt ?? "";

describe("BuiltinWorkflowDefinitionSource", () => {
  const source = new BuiltinWorkflowDefinitionSource();

  it("lists every builtin tagged source:builtin", () => {
    const records = source.list();
    const names = records.map((r) => r.name).sort();
    assert.deepEqual(names, ["build-with-experts", "research-analysis-planning"]);
    assert.ok(records.every((r) => r.source === "builtin"), "every builtin record is tagged source:builtin");
  });

  it("each builtin is a valid, laid-out v2 graph", () => {
    for (const def of BUILTIN_WORKFLOW_DEFINITIONS) {
      const res = WorkflowGraphSchema.safeParse(def);
      assert.ok(res.success, `${def.name} must parse as a v2 graph: ${res.success ? "" : JSON.stringify(res.error.issues)}`);
      const g = res.success ? res.data : null;
      assert.equal(g?.version, 2);
      assert.ok(g?.nodes.every((n) => typeof n.ui?.x === "number" && typeof n.ui?.y === "number"),
        `${def.name}: every node must carry a ui layout coordinate`);
    }
  });

  it("research-analysis-planning encodes the 3 → 5 → 2 barrier topology (§5.2)", () => {
    const g = WorkflowGraphSchema.parse(BUILTIN_WORKFLOW_DEFINITIONS.find((d) => d.name === "research-analysis-planning")!);
    assert.deepEqual(g.experts, []);
    assert.deepEqual(workerIdsWithPrefix(g.nodes, "research-"), ["research-0", "research-1", "research-2"]);
    assert.equal(workerIdsWithPrefix(g.nodes, "analysis-").length, 5);
    assert.equal(workerIdsWithPrefix(g.nodes, "plan-").length, 2);
    // The analysis pass synthesizes the FULL research corpus via the fan-out glob.
    assert.match(promptOf(g.nodes.find((n) => n.id === "analysis-0")), /\{\{nodes\.research-\*\.output\}\}/);
  });

  it("build-with-experts wires a standing expert pool + per-module forEach (§4.5)", () => {
    const g = WorkflowGraphSchema.parse(BUILTIN_WORKFLOW_DEFINITIONS.find((d) => d.name === "build-with-experts")!);
    assert.deepEqual(g.experts?.map((e) => e.id).sort(), ["patterns-expert", "solid-expert"]);
    assert.equal(g.nodes.find((n) => n.id === "plan")?.kind, "worker");
    // The fan-out iterates the typed module list from plan's output.
    const impl = g.nodes.find((n) => n.id === "impl");
    assert.equal(impl?.kind, "loop");
    const cfg = impl?.config as { loopKind?: string; over?: string };
    assert.equal(cfg.loopKind, "forEach");
    assert.equal(cfg.over, "{{nodes.plan.output.modules}}");
    // The barrier review reads the aggregated forEach output.
    assert.match(promptOf(g.nodes.find((n) => n.id === "review")), /\{\{nodes\.impl\.output\}\}/);
  });

  it("is resolvable by name and shadowable (overlay precedence — builtin listed first)", () => {
    // Replicates the container resolver's nearest-wins overlay (last match by name).
    const resolve = (name: string, records: AnyWorkflowDefinitionRecord[]) => {
      let found: AnyWorkflowDefinitionRecord | null = null;
      for (const r of records) if (r.name === name) found = r;
      return found;
    };
    const builtins = source.list();
    assert.equal(resolve("research-analysis-planning", builtins)?.source, "builtin");
    assert.equal(resolve("build-with-experts", builtins)?.source, "builtin");
    assert.equal(resolve("nope", builtins), null);

    // A user/runtime definition of the same name shadows the builtin (it is listed AFTER).
    const userOverride: AnyWorkflowDefinitionRecord = {
      name: "build-with-experts", source: "user",
      root: { type: "step", id: "x", prompt: "p" },
    };
    assert.equal(resolve("build-with-experts", [...builtins, userOverride])?.source, "user");
  });
});
