import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BindingScope } from "../workflow/bindings.ts";

describe("BindingScope.resolveRef", () => {
  it("resolves {{args.*}} to the raw value", () => {
    const b = new BindingScope({ topic: "rate limiting", depth: 3 });
    assert.equal(b.resolveRef("{{args.topic}}"), "rate limiting");
    assert.equal(b.resolveRef("args.depth"), 3); // bare path also works
  });

  it("resolves {{nodes.<id>.output}} and a subpath", () => {
    const b = new BindingScope();
    b.set("plan", { modules: ["a", "b"], count: 2 });
    assert.deepEqual(b.resolveRef("{{nodes.plan.output}}"), { modules: ["a", "b"], count: 2 });
    assert.deepEqual(b.resolveRef("{{nodes.plan.output.modules}}"), ["a", "b"]);
    assert.equal(b.resolveRef("{{nodes.plan.output.count}}"), 2);
  });

  it("aggregates fan-out outputs via the {{nodes.<prefix>-*.output}} glob", () => {
    const b = new BindingScope();
    b.set("research-0", { finding: "x" });
    b.set("research-1", { finding: "y" });
    b.set("research-2", { finding: "z" });
    b.set("analysis-0", { finding: "ignored" });
    assert.deepEqual(b.resolveRef("{{nodes.research-*.output}}"), [
      { finding: "x" }, { finding: "y" }, { finding: "z" },
    ]);
    // a subpath after a glob maps over each matched output
    assert.deepEqual(b.resolveRef("{{nodes.research-*.output.finding}}"), ["x", "y", "z"]);
  });

  it("aggregates a glob fan-in in stable id order regardless of completion order", () => {
    // Simulate out-of-order (concurrent) completion: outputs land in the binding
    // Map in a scrambled order, not the node-id order. The aggregate must still
    // come back sorted by id so the list is reproducible across runs.
    const scrambled = new BindingScope();
    scrambled.set("research-2", { finding: "z" });
    scrambled.set("research-0", { finding: "x" });
    scrambled.set("research-10", { finding: "ten" });
    scrambled.set("research-1", { finding: "y" });

    const expected = ["research-0", "research-1", "research-10", "research-2"].map((id) => scrambled.get(id));
    assert.deepEqual(scrambled.resolveRef("{{nodes.research-*.output}}"), expected);

    // A different completion order yields the IDENTICAL aggregate.
    const other = new BindingScope();
    other.set("research-1", { finding: "y" });
    other.set("research-10", { finding: "ten" });
    other.set("research-2", { finding: "z" });
    other.set("research-0", { finding: "x" });
    assert.deepEqual(
      other.resolveRef("{{nodes.research-*.output}}"),
      scrambled.resolveRef("{{nodes.research-*.output}}"),
    );
  });

  it("returns undefined for unknown roots / missing nodes", () => {
    const b = new BindingScope({ a: 1 });
    assert.equal(b.resolveRef("{{nodes.missing.output}}"), undefined);
    assert.equal(b.resolveRef("{{unknownRoot.x}}"), undefined);
    assert.equal(b.resolveRef("{{args.nope.deep}}"), undefined);
  });

  it("resolves an injected local (e.g. forEach {{item}})", () => {
    const b = new BindingScope();
    assert.equal(b.resolveRef("{{item}}", { item: "mod-A" }), "mod-A");
    assert.deepEqual(b.resolveRef("{{item.name}}", { item: { name: "mod-A" } }), "mod-A");
  });
});

describe("BindingScope.resolve (template → string)", () => {
  it("substitutes every token, stringifying objects as JSON", () => {
    const b = new BindingScope({ topic: "auth" });
    b.set("plan", { modules: ["a", "b"] });
    assert.equal(b.resolve("Research {{args.topic}}"), "Research auth");
    assert.equal(b.resolve("Plan: {{nodes.plan.output.modules}}"), 'Plan: ["a","b"]');
  });

  it("renders null/undefined as empty and primitives as-is", () => {
    const b = new BindingScope({ flag: true, n: 0 });
    assert.equal(b.resolve("[{{args.missing}}]"), "[]");
    assert.equal(b.resolve("{{args.flag}}/{{args.n}}"), "true/0");
  });
});
