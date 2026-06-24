import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BindingScope } from "../workflow/bindings.ts";
import { TransformFnRegistry, defaultTransformFnRegistry } from "../workflow/transforms.ts";
import {
  makeMapExecutor, makeFilterExecutor, makeDedupExecutor,
  makeTallyExecutor, makeAccumulateExecutor, makeTransformExecutor,
} from "../workflow/executors/glue.ts";
import type { WorkflowExecCtx } from "../ports/StepExecutor.ts";
import type {
  MapNode, FilterNode, DedupNode, TallyNode, AccumulateNode, TransformNode,
} from "../../../contracts/src/workflow-node.ts";

// Minimal ctx — the glue executors only ever touch ctx.bindings (+ the optional
// item/index locals, here unset). Everything else is unreachable from them.
function ctxWith(seed: Record<string, unknown>): WorkflowExecCtx {
  const bindings = new BindingScope();
  for (const [k, v] of Object.entries(seed)) bindings.set(k, v);
  return { bindings } as unknown as WorkflowExecCtx;
}
const over = (id: string) => `{{nodes.${id}.output}}`;

describe("TransformFnRegistry", () => {
  it("registers, gets, and reports unknown fns loudly", () => {
    const r = new TransformFnRegistry();
    r.register("double", (x) => (x as number) * 2);
    assert.equal(r.get("double")(21), 42);
    assert.equal(r.has("double"), true);
    assert.throws(() => r.get("nope"), /no transform fn "nope" \(registered: double\)/);
  });
});

describe("glue executors apply registered pure fns", () => {
  it("map — fn per item", async () => {
    const fns = defaultTransformFnRegistry();
    fns.register("double", (x) => (x as number) * 2);
    const ctx = ctxWith({ data: [1, 2, 3] });
    const node: MapNode = { type: "map", id: "m", fn: "double", over: over("data") };
    assert.deepEqual((await makeMapExecutor(fns).execute(node, ctx)).output, [2, 4, 6]);
  });

  it("filter — keep items where fn(item) is truthy", async () => {
    const fns = defaultTransformFnRegistry();
    const ctx = ctxWith({ data: [0, 1, "", 2, null, 3] });
    const node: FilterNode = { type: "filter", id: "f", fn: "isTruthy", over: over("data") };
    assert.deepEqual((await makeFilterExecutor(fns).execute(node, ctx)).output, [1, 2, 3]);
  });

  it("dedup — first occurrence per key (identity default)", async () => {
    const fns = defaultTransformFnRegistry();
    const ctx = ctxWith({ data: [1, 2, 2, 3, 1] });
    const node: DedupNode = { type: "dedup", id: "d", over: over("data") };
    assert.deepEqual((await makeDedupExecutor(fns).execute(node, ctx)).output, [1, 2, 3]);
  });

  it("dedup — by a key-extractor fn", async () => {
    const fns = defaultTransformFnRegistry();
    fns.register("byId", (x) => (x as { id: number }).id);
    const ctx = ctxWith({ data: [{ id: 1 }, { id: 1 }, { id: 2 }] });
    const node: DedupNode = { type: "dedup", id: "d", over: over("data"), fn: "byId" };
    assert.deepEqual((await makeDedupExecutor(fns).execute(node, ctx)).output, [{ id: 1 }, { id: 2 }]);
  });

  it("tally — count by key (majority-vote shape)", async () => {
    const fns = defaultTransformFnRegistry();
    const ctx = ctxWith({ votes: ["a", "b", "a", "a"] });
    const node: TallyNode = { type: "tally", id: "t", over: over("votes") };
    assert.deepEqual((await makeTallyExecutor(fns).execute(node, ctx)).output, { a: 3, b: 1 });
  });

  it("accumulate — fold with init", async () => {
    const fns = defaultTransformFnRegistry();
    const ctx = ctxWith({ nums: [1, 2, 3, 4] });
    const node: AccumulateNode = { type: "accumulate", id: "acc", fn: "sum", over: over("nums"), init: 0 };
    assert.equal((await makeAccumulateExecutor(fns).execute(node, ctx)).output, 10);
  });

  it("transform — apply fn to the whole value", async () => {
    const fns = defaultTransformFnRegistry();
    const ctx = ctxWith({ nested: [[1, 2], [3], [4, 5]] });
    const node: TransformNode = { type: "transform", id: "tr", fn: "flatten", over: over("nested") };
    assert.deepEqual((await makeTransformExecutor(fns).execute(node, ctx)).output, [1, 2, 3, 4, 5]);
  });

  it("built-ins: compact / unique", async () => {
    const fns = defaultTransformFnRegistry();
    const ctx = ctxWith({ a: [1, null, 2, undefined, 3], b: [1, 1, 2, 2, 3] });
    const compact: TransformNode = { type: "transform", id: "c", fn: "compact", over: over("a") };
    const unique: TransformNode = { type: "transform", id: "u", fn: "unique", over: over("b") };
    assert.deepEqual((await makeTransformExecutor(fns).execute(compact, ctx)).output, [1, 2, 3]);
    assert.deepEqual((await makeTransformExecutor(fns).execute(unique, ctx)).output, [1, 2, 3]);
  });
});
