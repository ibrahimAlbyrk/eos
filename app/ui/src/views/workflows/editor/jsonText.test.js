import { describe, it, expect } from "vitest";
import { parseJson, validateJsonSchema, formatJson } from "./jsonText.js";

describe("jsonText — parseJson", () => {
  it("treats empty/whitespace as undefined (the field is omitted)", () => {
    expect(parseJson("")).toEqual({ ok: true, value: undefined });
    expect(parseJson("   \n ")).toEqual({ ok: true, value: undefined });
    expect(parseJson(null)).toEqual({ ok: true, value: undefined });
  });

  it("parses valid JSON and reports an error (never throws) on invalid", () => {
    expect(parseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJson("[1,2,3]")).toEqual({ ok: true, value: [1, 2, 3] });
    expect(parseJson("42")).toEqual({ ok: true, value: 42 });
    const bad = parseJson("{nope}");
    expect(bad.ok).toBe(false);
    expect(typeof bad.error).toBe("string");
  });
});

describe("jsonText — validateJsonSchema", () => {
  it("accepts an empty field and a plain-object schema", () => {
    expect(validateJsonSchema("")).toEqual({ ok: true, value: undefined });
    const r = validateJsonSchema('{"type":"object","properties":{"x":{"type":"number"}}}');
    expect(r.ok).toBe(true);
    expect(r.value.type).toBe("object");
  });

  it("rejects a non-object schema (array / scalar) and invalid JSON", () => {
    expect(validateJsonSchema("[1,2]").ok).toBe(false);
    expect(validateJsonSchema('"str"').ok).toBe(false);
    expect(validateJsonSchema("5").ok).toBe(false);
    expect(validateJsonSchema("{bad").ok).toBe(false);
  });

  it("rejects a JSON-valid but structurally-wrong schema (so it never silently commits)", () => {
    const typo = validateJsonSchema('{"typ":"objct"}');
    expect(typo.ok).toBe(false);
    expect(typo.error).toMatch(/unknown schema keyword "typ"/);
    expect(validateJsonSchema('{"type":"objct"}').ok).toBe(false); // bad type value
    expect(validateJsonSchema('{"type":"object","properties":{"x":{"type":"strng"}}}').ok).toBe(false); // nested bad type
  });
});

describe("jsonText — formatJson", () => {
  it("pretty-prints a value and maps undefined to empty string", () => {
    expect(formatJson(undefined)).toBe("");
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
