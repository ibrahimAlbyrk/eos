import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../workflow/predicate.ts";
import { BindingScope } from "../workflow/bindings.ts";
import type { Predicate } from "../../../contracts/src/workflow-node.ts";

function scope(): BindingScope {
  const b = new BindingScope({ mode: "fast" });
  b.set("review", { output: undefined }); // placeholder; outputs set below
  b.set("review", { verdict: "approved", score: 7 });
  b.set("plan", { modules: ["a"] });
  return b;
}

describe("predicate.evaluate", () => {
  it("eq compares a resolved ref against a literal", () => {
    const b = scope();
    const yes: Predicate = { op: "eq", left: "{{nodes.review.output.verdict}}", right: "approved" };
    const no: Predicate = { op: "eq", left: "{{nodes.review.output.verdict}}", right: "rejected" };
    assert.equal(evaluate(yes, b), true);
    assert.equal(evaluate(no, b), false);
  });

  it("eq compares a ref against another ref", () => {
    const b = scope();
    const p: Predicate = { op: "eq", left: "{{args.mode}}", right: "{{args.mode}}" };
    assert.equal(evaluate(p, b), true);
  });

  it("eq without right falls back to truthiness of the resolved ref", () => {
    const b = scope();
    assert.equal(evaluate({ op: "eq", left: "{{nodes.review.output.verdict}}" }, b), true);
    assert.equal(evaluate({ op: "eq", left: "{{nodes.missing.output}}" }, b), false);
  });

  it("exists is true only when the ref resolves to a non-null value", () => {
    const b = scope();
    assert.equal(evaluate({ op: "exists", ref: "{{nodes.plan.output.modules}}" }, b), true);
    assert.equal(evaluate({ op: "exists", ref: "{{nodes.plan.output.missing}}" }, b), false);
  });

  it("and / or compose clauses", () => {
    const b = scope();
    const a: Predicate = { op: "exists", ref: "{{nodes.plan.output}}" };
    const c: Predicate = { op: "eq", left: "{{nodes.review.output.verdict}}", right: "approved" };
    const wrong: Predicate = { op: "eq", left: "{{nodes.review.output.verdict}}", right: "no" };
    assert.equal(evaluate({ op: "and", clauses: [a, c] }, b), true);
    assert.equal(evaluate({ op: "and", clauses: [a, wrong] }, b), false);
    assert.equal(evaluate({ op: "or", clauses: [wrong, c] }, b), true);
    assert.equal(evaluate({ op: "or", clauses: [wrong, wrong] }, b), false);
  });
});
