import { describe, it, expect } from "vitest";
import {
  SCHEMA_FIELD_TYPES, emptyRow, isRepresentableSchema, describeNonRepresentable,
  schemaToRows, rowsToSchema, addRow, removeRow, updateRow,
} from "./schemaRowsModel.js";
// A row-built schema must always be well-formed per the daemon's vocabulary.
import { metaValidateSchema } from "./jsonSchemaCheck.js";

describe("schemaRowsModel — vocabulary + empty row", () => {
  it("exposes the daemon's leaf type vocabulary", () => {
    expect(SCHEMA_FIELD_TYPES).toEqual(["string", "number", "integer", "boolean", "object", "array", "null"]);
    expect(emptyRow()).toEqual({ name: "", type: "string", required: false });
  });
});

describe("schemaRowsModel — representability (flat object only)", () => {
  it("accepts undefined, an empty object, and a flat scalar-property object", () => {
    expect(isRepresentableSchema(undefined)).toBe(true);
    expect(isRepresentableSchema({})).toBe(true);
    expect(isRepresentableSchema({ type: "object" })).toBe(true);
    expect(isRepresentableSchema({ type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a"] })).toBe(true);
  });

  it("rejects advanced constructs the rows can't carry (and says why)", () => {
    const cases = [
      { type: "object", properties: { a: { type: "object", properties: { x: { type: "string" } } } } }, // nested object
      { type: "object", properties: { a: { type: "array", items: { type: "object" } } } }, // array-of-objects
      { type: "object", properties: { a: { type: "string", enum: ["x"] } } }, // constrained leaf
      { oneOf: [{ type: "string" }] }, // oneOf
      { $ref: "#/$defs/x" }, // $ref
      { type: "array" }, // non-object top level
      { type: "object", additionalProperties: false }, // unowned keyword
      [1, 2], // not an object
    ];
    for (const c of cases) {
      expect(isRepresentableSchema(c)).toBe(false);
      expect(typeof describeNonRepresentable(c)).toBe("string");
    }
    expect(describeNonRepresentable({ type: "object", properties: { a: { type: "string" } } })).toBeNull();
  });

  it("a bare array/object leaf type IS representable (no items/properties)", () => {
    expect(isRepresentableSchema({ type: "object", properties: { tags: { type: "array" }, meta: { type: "object" } } })).toBe(true);
  });
});

describe("schemaRowsModel — parse / compile round-trip", () => {
  it("schemaToRows is the inverse of rowsToSchema", () => {
    const schema = { type: "object", properties: { facts: { type: "array" }, count: { type: "integer" } }, required: ["facts"] };
    const rows = schemaToRows(schema);
    expect(rows).toEqual([
      { name: "facts", type: "array", required: true },
      { name: "count", type: "integer", required: false },
    ]);
    expect(rowsToSchema(rows)).toEqual(schema);
  });

  it("schemaToRows yields no rows for empty / non-representable values", () => {
    expect(schemaToRows(undefined)).toEqual([]);
    expect(schemaToRows({})).toEqual([]);
    expect(schemaToRows({ oneOf: [] })).toEqual([]);
  });

  it("rowsToSchema drops unnamed rows and omits an empty required[]", () => {
    expect(rowsToSchema([])).toBeUndefined();
    expect(rowsToSchema([emptyRow()])).toBeUndefined(); // empty name → no field
    expect(rowsToSchema([{ name: "x", type: "boolean", required: false }])).toEqual({ type: "object", properties: { x: { type: "boolean" } } });
    expect(rowsToSchema([{ name: " y ", type: "number", required: true }])).toEqual({ type: "object", properties: { y: { type: "number" } }, required: ["y"] });
  });

  it("a row-built schema is always well-formed (the builder can't emit an invalid type)", () => {
    const rows = [
      { name: "a", type: "string", required: true },
      { name: "b", type: "bogus", required: false }, // clamped to string
    ];
    const schema = rowsToSchema(rows);
    expect(schema.properties.b).toEqual({ type: "string" });
    expect(metaValidateSchema(schema)).toEqual([]);
  });
});

describe("schemaRowsModel — immutable row editing", () => {
  it("add / update / remove rows without mutating the source", () => {
    const a = [emptyRow()];
    const b = addRow(a);
    expect(b.length).toBe(2);
    expect(a.length).toBe(1);
    const c = updateRow(b, 0, { name: "id", type: "number" });
    expect(c[0]).toEqual({ name: "id", type: "number", required: false });
    expect(b[0].name).toBe("");
    const d = removeRow(c, 1);
    expect(d.length).toBe(1);
  });
});
