import { describe, it, expect } from "vitest";
import { validateValue, metaValidateSchema, isPlainObject } from "./jsonSchemaCheck.js";

// validateValue mirrors the daemon's compileJsonSchema().safeParse — these cases
// track manager/services/__tests__/json-schema-validator.test.ts so edit-time and
// run-time agree.
describe("jsonSchemaCheck — validateValue (data against schema)", () => {
  it("object: enforces required and validates declared properties", () => {
    const schema = { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] };
    expect(validateValue(schema, { facts: ["a", "b"] })).toEqual([]);
    expect(validateValue(schema, { facts: [], extra: 1 })).toEqual([]); // unknown props pass
    expect(validateValue(schema, {}).length).toBeGreaterThan(0); // missing required
    expect(validateValue(schema, { facts: "x" }).length).toBeGreaterThan(0); // wrong type
    expect(validateValue(schema, { facts: [1, 2] }).length).toBeGreaterThan(0); // item mismatch
  });

  it("primitives, enum, and nullability match the daemon", () => {
    expect(validateValue({ type: "integer" }, 3)).toEqual([]);
    expect(validateValue({ type: "integer" }, 3.5).length).toBe(1);
    expect(validateValue({ enum: ["a", "b"] }, "a")).toEqual([]);
    expect(validateValue({ enum: ["a", "b"] }, "c").length).toBe(1);
    expect(validateValue({ type: "string", nullable: true }, null)).toEqual([]);
    expect(validateValue({ type: ["string", "null"] }, null)).toEqual([]);
    expect(validateValue({ type: "string" }, null).length).toBe(1);
  });

  it("a non-schema (or empty schema) enforces nothing — permissive like the daemon", () => {
    expect(validateValue(undefined, { anything: true })).toEqual([]);
    expect(validateValue({}, 42)).toEqual([]);
  });
});

describe("jsonSchemaCheck — metaValidateSchema (the schema itself)", () => {
  it("accepts a well-formed schema, including type arrays and tolerated annotations", () => {
    expect(metaValidateSchema({ type: "object", properties: { x: { type: "number" } }, required: ["x"] })).toEqual([]);
    expect(metaValidateSchema({ type: ["string", "null"] })).toEqual([]);
    expect(metaValidateSchema({ type: "object", description: "hi", additionalProperties: false, minProperties: 1 })).toEqual([]);
  });

  it("flags a misspelled core keyword (the {typ:objct} case)", () => {
    const errs = metaValidateSchema({ typ: "objct" });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(" ")).toMatch(/unknown schema keyword "typ"/);
  });

  it("flags a bad `type` value, at the top level and nested", () => {
    expect(metaValidateSchema({ type: "objct" }).join(" ")).toMatch(/not a valid type/);
    const nested = metaValidateSchema({ type: "object", properties: { x: { type: "strng" } } });
    expect(nested.join(" ")).toMatch(/properties\.x\.type/);
  });

  it("flags malformed keyword value-shapes", () => {
    expect(metaValidateSchema({ required: "x" }).join(" ")).toMatch(/required/);
    expect(metaValidateSchema({ properties: "nope" }).join(" ")).toMatch(/properties/);
    expect(metaValidateSchema({ enum: [] }).join(" ")).toMatch(/enum/);
    expect(metaValidateSchema({ type: "string", nullable: "yes" }).join(" ")).toMatch(/nullable/);
    expect(metaValidateSchema({ type: "array", items: { type: "nope" } }).join(" ")).toMatch(/items\.type/);
  });

  it("rejects a non-object as not a schema", () => {
    expect(metaValidateSchema([1, 2]).length).toBe(1);
  });
});

describe("jsonSchemaCheck — isPlainObject", () => {
  it("is true only for plain objects", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("x")).toBe(false);
  });
});
