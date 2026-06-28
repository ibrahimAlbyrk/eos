import { describe, it, expect } from "vitest";
import {
  emptyArgRow, isRepresentableArgs, describeNonRepresentableArgs, argsToRows, rowsToArgs,
  expectedArgType, requiredArgKeys, prefillRowsFromSchema, initialArgRows,
  coerceArgValue, argValueText, addArgRow, removeArgRow, updateArgRow,
} from "./argsRowsModel.js";
// A row-built args object must validate against the target schema like the daemon would.
import { validateValue } from "./jsonSchemaCheck.js";

describe("argsRowsModel — representability (flat scalar object)", () => {
  it("accepts undefined and flat scalar objects; rejects nested / array values", () => {
    expect(isRepresentableArgs(undefined)).toBe(true);
    expect(isRepresentableArgs({ a: "x", b: 5, c: true, d: null })).toBe(true);
    expect(isRepresentableArgs({ a: { nested: 1 } })).toBe(false);
    expect(isRepresentableArgs({ a: [1, 2] })).toBe(false);
    expect(isRepresentableArgs([1])).toBe(false);
    expect(describeNonRepresentableArgs({ a: [1] })).toMatch(/array/);
    expect(describeNonRepresentableArgs({ a: { x: 1 } })).toMatch(/nested object/);
    expect(describeNonRepresentableArgs({ a: "x" })).toBeNull();
  });
});

describe("argsRowsModel — parse / compile round-trip", () => {
  it("argsToRows is the inverse of rowsToArgs", () => {
    const args = { topic: "auth", limit: 3, deep: true };
    const rows = argsToRows(args);
    expect(rows).toEqual([
      { key: "topic", value: "auth" },
      { key: "limit", value: 3 },
      { key: "deep", value: true },
    ]);
    expect(rowsToArgs(rows)).toEqual(args);
  });

  it("rowsToArgs drops unnamed + unset rows, undefined when empty", () => {
    expect(rowsToArgs([])).toBeUndefined();
    expect(rowsToArgs([emptyArgRow()])).toBeUndefined();
    expect(rowsToArgs([{ key: "x", value: undefined }])).toBeUndefined();
    expect(rowsToArgs([{ key: " a ", value: 1 }, { key: "", value: 2 }])).toEqual({ a: 1 });
  });
});

describe("argsRowsModel — target-schema typing + prefill", () => {
  const schema = { type: "object", properties: { topic: { type: "string" }, limit: { type: "integer" }, flag: { type: ["boolean", "null"] } }, required: ["topic"] };

  it("reads the expected type (resolving a null-union) and required keys", () => {
    expect(expectedArgType(schema, "topic")).toBe("string");
    expect(expectedArgType(schema, "limit")).toBe("integer");
    expect(expectedArgType(schema, "flag")).toBe("boolean");
    expect(expectedArgType(schema, "missing")).toBeUndefined();
    expect(expectedArgType(undefined, "topic")).toBeUndefined();
    expect(requiredArgKeys(schema)).toEqual(["topic"]);
  });

  it("prefills empty-valued rows from the schema's properties (in order)", () => {
    expect(prefillRowsFromSchema(schema)).toEqual([
      { key: "topic", value: undefined },
      { key: "limit", value: undefined },
      { key: "flag", value: undefined },
    ]);
    // initialArgRows prefers existing args, falls back to the prefilled shape
    expect(initialArgRows({ topic: "x" }, schema)).toEqual([{ key: "topic", value: "x" }]);
    expect(initialArgRows(undefined, schema).map((r) => r.key)).toEqual(["topic", "limit", "flag"]);
  });

  it("a row-built args object satisfies the target schema (round-trips through validateValue)", () => {
    let rows = initialArgRows(undefined, schema);
    rows = updateArgRow(rows, 0, { value: coerceArgValue("auth", "string") });
    rows = updateArgRow(rows, 1, { value: coerceArgValue("5", "integer") });
    expect(rowsToArgs(rows)).toEqual({ topic: "auth", limit: 5 });
    expect(validateValue(schema, rowsToArgs(rows))).toEqual([]);
  });
});

describe("argsRowsModel — value coercion", () => {
  it("coerces to the expected type, leaving bad numbers as text for validation to flag", () => {
    expect(coerceArgValue("hi", "string")).toBe("hi");
    expect(coerceArgValue("12", "string")).toBe("12"); // string stays string
    expect(coerceArgValue("12", "number")).toBe(12);
    expect(coerceArgValue("nope", "integer")).toBe("nope");
    expect(coerceArgValue("true", "boolean")).toBe(true);
    expect(coerceArgValue("false", "boolean")).toBe(false);
    expect(coerceArgValue("", "string")).toBeUndefined(); // empty → unset
  });

  it("falls back to JSON-ish coercion with no known type", () => {
    expect(coerceArgValue("42", undefined)).toBe(42);
    expect(coerceArgValue("true", undefined)).toBe(true);
    expect(coerceArgValue("null", undefined)).toBe(null);
    expect(coerceArgValue("text", undefined)).toBe("text");
  });

  it("argValueText is the inverse of a stored value", () => {
    expect(argValueText(undefined)).toBe("");
    expect(argValueText(null)).toBe("null");
    expect(argValueText(5)).toBe("5");
    expect(argValueText(false)).toBe("false");
  });
});

describe("argsRowsModel — immutable row editing", () => {
  it("add / update / remove rows without mutating the source", () => {
    const a = [emptyArgRow()];
    const b = addArgRow(a);
    expect(b.length).toBe(2);
    expect(a.length).toBe(1);
    const c = updateArgRow(b, 0, { key: "topic" });
    expect(c[0].key).toBe("topic");
    expect(b[0].key).toBe("");
    expect(removeArgRow(c, 1).length).toBe(1);
  });
});
