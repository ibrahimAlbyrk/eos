import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowNodeSchema,
  WORKFLOW_NODE_TYPES,
  type WorkflowNode,
} from "../workflow-node.ts";
import {
  WorkflowDefinitionSchema,
  WorkflowToolRequestSchema,
  WorkflowRunSchema,
  WorkflowStepSchema,
  StepResultRequestSchema,
} from "../workflow.ts";

// One minimal valid instance per node `type`, so the union is exercised member
// by member (and the list stays in lockstep with the schema).
const SAMPLES: Record<(typeof WORKFLOW_NODE_TYPES)[number], WorkflowNode> = {
  step: { type: "step", id: "s", prompt: "p" },
  sequence: { type: "sequence", id: "s", children: [] },
  parallel: { type: "parallel", id: "s", children: [] },
  pipeline: { type: "pipeline", id: "s", over: "o", stages: [] },
  forEach: { type: "forEach", id: "s", over: "o", body: { type: "step", id: "b", prompt: "p" } },
  conditional: {
    type: "conditional", id: "s",
    predicate: { op: "exists", ref: "r" },
    then: { type: "step", id: "t", prompt: "p" },
  },
  loopUntil: { type: "loopUntil", id: "s", body: { type: "step", id: "b", prompt: "p" }, maxIterations: 3 },
  phase: { type: "phase", id: "s", label: "l", body: { type: "step", id: "b", prompt: "p" } },
  subWorkflow: { type: "subWorkflow", id: "s", name: "n" },
  transform: { type: "transform", id: "s", fn: "f", over: "o" },
  map: { type: "map", id: "s", fn: "f", over: "o" },
  filter: { type: "filter", id: "s", fn: "f", over: "o" },
  dedup: { type: "dedup", id: "s", over: "o" },
  tally: { type: "tally", id: "s", over: "o" },
  accumulate: { type: "accumulate", id: "s", fn: "f", over: "o" },
};

describe("WorkflowNode union", () => {
  it("is exhaustive over the 15 declared node types", () => {
    assert.equal(WORKFLOW_NODE_TYPES.length, 15);
    assert.equal(new Set(WORKFLOW_NODE_TYPES).size, 15);
  });

  it("parses one valid instance of every node type", () => {
    for (const type of WORKFLOW_NODE_TYPES) {
      assert.equal(WorkflowNodeSchema.parse(SAMPLES[type]).type, type);
    }
  });

  it("validates deep recursion (sequence → phase → forEach → step)", () => {
    const tree = {
      type: "sequence", id: "root",
      children: [
        { type: "phase", id: "ph", label: "impl", body: {
          type: "forEach", id: "fe", over: "{{nodes.plan.output}}",
          body: { type: "step", id: "leaf", from: "impl", prompt: "do {{item}}" } } },
      ],
    };
    const parsed = WorkflowNodeSchema.parse(tree);
    assert.equal(parsed.type, "sequence");
  });

  it("evaluates a recursive predicate (and/or nesting)", () => {
    const node = {
      type: "conditional", id: "c",
      predicate: { op: "and", clauses: [
        { op: "exists", ref: "{{nodes.x.output}}" },
        { op: "or", clauses: [{ op: "eq", left: "{{args.mode}}", right: "full" }] },
      ] },
      then: { type: "step", id: "t", prompt: "go" },
    };
    assert.equal(WorkflowNodeSchema.parse(node).type, "conditional");
  });

  it("rejects an unknown node type", () => {
    assert.throws(() => WorkflowNodeSchema.parse({ type: "bogus", id: "x" }));
  });
});

describe("WorkflowDefinition + tool surface", () => {
  it("parses a definition with a standing expert pool", () => {
    const def = WorkflowDefinitionSchema.parse({
      name: "build-with-experts",
      experts: [{ id: "solid-expert", from: "solid-expert", prompt: "stay idle" }],
      root: SAMPLES.sequence,
    });
    assert.equal(def.experts?.[0].id, "solid-expert");
    assert.equal(def.root.type, "sequence");
  });

  it("accepts all 5 WorkflowToolRequest modes and rejects an unknown mode", () => {
    const def = { name: "w", root: SAMPLES.step };
    for (const req of [
      { mode: "run-stored", from: "x" },
      { mode: "run-inline", spec: def },
      { mode: "create", spec: def },
      { mode: "status", runId: "r" },
      { mode: "stop", runId: "r" },
    ]) {
      assert.ok(WorkflowToolRequestSchema.parse(req));
    }
    assert.throws(() => WorkflowToolRequestSchema.parse({ mode: "bogus" }));
  });
});

describe("persisted rows + typed step I/O", () => {
  it("parses a run row and a step row", () => {
    const run = WorkflowRunSchema.parse({
      id: "run-1", definitionName: null, owner: "o", anchorId: "run-1",
      status: "running", startedAt: 1, updatedAt: 1,
    });
    assert.equal(run.status, "running");
    const step = WorkflowStepSchema.parse({
      id: "st-1", runId: "run-1", nodeId: "plan", nodeType: "step",
      status: "passed", workerId: null, startedAt: 1, endedAt: null,
    });
    assert.equal(step.status, "passed");
  });

  it("carries arbitrary typed step output", () => {
    assert.deepEqual(StepResultRequestSchema.parse({ output: { modules: ["a"] } }).output, { modules: ["a"] });
  });
});
