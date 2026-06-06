import { describe, it, expect } from "vitest";
import { findPlaceholders, nextPlaceholder, prevPlaceholder } from "./placeholders.js";

describe("findPlaceholders", () => {
  it("finds all {{...}} tokens with offsets and labels", () => {
    const text = "Fix {{file}}.\nRepro: {{steps}}";
    expect(findPlaceholders(text)).toEqual([
      { start: 4, end: 12, label: "file" },
      { start: 21, end: 30, label: "steps" },
    ]);
  });

  it("allows empty and spaced labels, rejects newlines and nesting", () => {
    expect(findPlaceholders("{{}} {{two words}}").map((p) => p.label)).toEqual(["", "two words"]);
    expect(findPlaceholders("{{a\nb}}")).toEqual([]);
    expect(findPlaceholders("plain text")).toEqual([]);
  });
});

describe("nextPlaceholder / prevPlaceholder", () => {
  const phs = findPlaceholders("a {{x}} b {{y}} c");
  // {{x}}: 2-7, {{y}}: 10-15

  it("next finds first at/after offset", () => {
    expect(nextPlaceholder(phs, 0).label).toBe("x");
    expect(nextPlaceholder(phs, 2).label).toBe("x");
    expect(nextPlaceholder(phs, 7).label).toBe("y");
  });

  it("next wraps past the end", () => {
    expect(nextPlaceholder(phs, 16).label).toBe("x");
  });

  it("prev finds last ending at/before offset and wraps", () => {
    expect(prevPlaceholder(phs, 16).label).toBe("y");
    expect(prevPlaceholder(phs, 10).label).toBe("x");
    expect(prevPlaceholder(phs, 0).label).toBe("y");
  });

  it("returns null on empty list", () => {
    expect(nextPlaceholder([], 0)).toBeNull();
    expect(prevPlaceholder([], 0)).toBeNull();
  });
});
