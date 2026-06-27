import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WorkflowGraphSchema,
  isPortTypeAssignable,
  WORKFLOW_GRAPH_VERSION,
  type PortType,
} from "../workflow-graph.ts";

// Phase 3 authoring-time proof: the v2 graph contract type-checks edges. An upstream
// output port type must be assignable to the downstream input port type; an
// incompatible edge is rejected with a message naming the edge + both types. The
// `any` escape hatch keeps every lowered-tree port (treeToGraph defaults to `any`)
// compatible, so the legacy compile path is never rejected.

function firstError(result: ReturnType<typeof WorkflowGraphSchema.safeParse>): string {
  assert.equal(result.success, false);
  return result.success ? "" : result.error.issues.map((i) => i.message).join(" | ");
}

// A two-worker graph wiring A's single output port to B's single input port, with
// the port types under test. input/output framing is fixed; only the typed edge varies.
function typedEdge(fromType: PortType, toType: PortType): unknown {
  return {
    name: "g",
    version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "a", kind: "worker", outputs: [{ name: "out", type: fromType }] },
      { id: "b", kind: "worker", inputs: [{ name: "val", type: toType }] },
      { id: "out", kind: "output" },
    ],
    edges: [
      { from: { node: "in" }, to: { node: "a" } },
      { from: { node: "a", port: "out" }, to: { node: "b", port: "val" } },
      { from: { node: "b" }, to: { node: "out" } },
    ],
  };
}

describe("isPortTypeAssignable — the edge type-compatibility rule", () => {
  it("`any` is the untyped escape hatch — assignable in both directions", () => {
    for (const t of ["string", "number", "boolean", "object", "array", "json"] as PortType[]) {
      assert.ok(isPortTypeAssignable("any", t), `any → ${t}`);
      assert.ok(isPortTypeAssignable(t, "any"), `${t} → any`);
    }
  });

  it("identical concrete types are assignable", () => {
    for (const t of ["string", "number", "boolean", "object", "array", "json"] as PortType[]) {
      assert.ok(isPortTypeAssignable(t, t));
    }
  });

  it("`json` (a typed object) is interchangeable with `object`", () => {
    assert.ok(isPortTypeAssignable("json", "object"));
    assert.ok(isPortTypeAssignable("object", "json"));
  });

  it("distinct concrete types are NOT assignable", () => {
    assert.ok(!isPortTypeAssignable("string", "number"));
    assert.ok(!isPortTypeAssignable("number", "string"));
    assert.ok(!isPortTypeAssignable("array", "object"));
    assert.ok(!isPortTypeAssignable("object", "array"));
    assert.ok(!isPortTypeAssignable("string", "json"));
    assert.ok(!isPortTypeAssignable("array", "json"));
  });
});

describe("WorkflowGraph schema — accepts type-compatible edges", () => {
  it("accepts a same-typed edge (string → string)", () => {
    assert.equal(WorkflowGraphSchema.safeParse(typedEdge("string", "string")).success, true);
  });

  it("accepts a json → object edge (json is an object)", () => {
    assert.equal(WorkflowGraphSchema.safeParse(typedEdge("json", "object")).success, true);
  });

  it("accepts any → number (the untyped source escape hatch — preserves legacy graphs)", () => {
    assert.equal(WorkflowGraphSchema.safeParse(typedEdge("any", "number")).success, true);
  });
});

describe("WorkflowGraph schema — rejects type-incompatible edges (naming the edge + types)", () => {
  it("rejects string → number, naming the edge and both types", () => {
    const r = WorkflowGraphSchema.safeParse(typedEdge("string", "number"));
    const msg = firstError(r);
    assert.match(msg, /a\.out → b\.val/, "names the offending edge endpoints");
    assert.match(msg, /"string" is not assignable to input type "number"/, "names both types");
  });

  it("rejects array → object", () => {
    assert.match(firstError(WorkflowGraphSchema.safeParse(typedEdge("array", "object"))), /not assignable/);
  });
});
