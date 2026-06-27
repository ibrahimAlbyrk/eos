import { describe, it, expect } from "vitest";
import {
  PREDICATE_OPS, defaultPredicate, makePredicate, changeOp, withLeft, withRef,
  rightMode, withRightMode, withRightValue, coerceLiteral, literalText,
  addClause, removeClause, replaceClause, isPredicateComplete,
} from "./predicateModel.js";
// Every predicate the builder produces must round-trip through the contract.
import { PredicateSchema } from "../../../../../../contracts/src/workflow-node.ts";

describe("predicateModel — ops + construction", () => {
  it("exposes the closed op set and builds an empty predicate per op", () => {
    expect(PREDICATE_OPS).toEqual(["eq", "exists", "and", "or"]);
    expect(makePredicate("eq")).toEqual({ op: "eq", left: "" });
    expect(makePredicate("exists")).toEqual({ op: "exists", ref: "" });
    expect(makePredicate("and")).toEqual({ op: "and", clauses: [] });
    expect(makePredicate("or")).toEqual({ op: "or", clauses: [] });
    expect(defaultPredicate()).toEqual({ op: "eq", left: "" });
  });

  it("changeOp carries over what still applies (eq.left ⇄ exists.ref, and⇄or clauses)", () => {
    expect(changeOp({ op: "eq", left: "{{args.x}}" }, "exists")).toEqual({ op: "exists", ref: "{{args.x}}" });
    expect(changeOp({ op: "exists", ref: "{{args.y}}" }, "eq")).toEqual({ op: "eq", left: "{{args.y}}" });
    const a = { op: "and", clauses: [{ op: "exists", ref: "r" }] };
    expect(changeOp(a, "or")).toEqual({ op: "or", clauses: [{ op: "exists", ref: "r" }] });
  });
});

describe("predicateModel — eq right modes (truthy / ref / literal)", () => {
  it("infers the right mode from the stored value", () => {
    expect(rightMode({ op: "eq", left: "x" })).toBe("truthy");
    expect(rightMode({ op: "eq", left: "x", right: "{{args.y}}" })).toBe("ref");
    expect(rightMode({ op: "eq", left: "x", right: 5 })).toBe("literal");
    expect(rightMode({ op: "eq", left: "x", right: "hello" })).toBe("literal");
  });

  it("switches modes and drops `right` entirely in truthy mode", () => {
    let p = { op: "eq", left: "x", right: 5 };
    p = withRightMode(p, "truthy");
    expect("right" in p).toBe(false);
    p = withRightMode(p, "ref");
    expect(p.right).toBe("");
    p = withRightValue(p, "{{args.z}}", "ref");
    expect(p.right).toBe("{{args.z}}");
  });

  it("coerces literal text to its JSON-ish type", () => {
    expect(coerceLiteral("12")).toBe(12);
    expect(coerceLiteral("-3.5")).toBe(-3.5);
    expect(coerceLiteral("true")).toBe(true);
    expect(coerceLiteral("false")).toBe(false);
    expect(coerceLiteral("null")).toBe(null);
    expect(coerceLiteral("done")).toBe("done");
    expect(literalText(null)).toBe("null");
    expect(literalText(5)).toBe("5");
  });

  it("withLeft / withRef update their operands", () => {
    expect(withLeft({ op: "eq", left: "" }, "{{item}}")).toEqual({ op: "eq", left: "{{item}}" });
    expect(withRef({ op: "exists", ref: "" }, "{{args.k}}")).toEqual({ op: "exists", ref: "{{args.k}}" });
  });
});

describe("predicateModel — and/or clause editing", () => {
  it("adds, replaces and removes clauses immutably", () => {
    let p = makePredicate("and");
    p = addClause(p, { op: "exists", ref: "a" });
    p = addClause(p, { op: "exists", ref: "b" });
    expect(p.clauses.length).toBe(2);
    p = replaceClause(p, 0, { op: "eq", left: "{{args.x}}", right: 1 });
    expect(p.clauses[0]).toEqual({ op: "eq", left: "{{args.x}}", right: 1 });
    p = removeClause(p, 1);
    expect(p.clauses.map((c) => c.op)).toEqual(["eq"]);
  });
});

describe("predicateModel — completeness + contract round-trip", () => {
  it("isPredicateComplete flags empty operands at any depth", () => {
    expect(isPredicateComplete({ op: "eq", left: "" })).toBe(false);
    expect(isPredicateComplete({ op: "eq", left: "{{args.x}}" })).toBe(true);
    expect(isPredicateComplete({ op: "exists", ref: "" })).toBe(false);
    expect(isPredicateComplete({ op: "and", clauses: [] })).toBe(false);
    expect(isPredicateComplete({ op: "or", clauses: [{ op: "exists", ref: "" }] })).toBe(false);
    expect(isPredicateComplete({ op: "and", clauses: [{ op: "exists", ref: "r" }] })).toBe(true);
  });

  it("a builder-composed predicate parses against the contract schema", () => {
    let p = makePredicate("and");
    p = addClause(p, withRightValue(withLeft(makePredicate("eq"), "{{nodes.a.output}}"), "true", "literal"));
    p = addClause(p, withRef(makePredicate("exists"), "{{args.ready}}"));
    expect(() => PredicateSchema.parse(p)).not.toThrow();
    expect(p).toEqual({
      op: "and",
      clauses: [
        { op: "eq", left: "{{nodes.a.output}}", right: true },
        { op: "exists", ref: "{{args.ready}}" },
      ],
    });
  });
});
