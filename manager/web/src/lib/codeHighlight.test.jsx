import { describe, it, expect } from "vitest";
import { highlightToLines } from "./codeHighlight.jsx";

describe("highlightToLines", () => {
  it("returns one node-array per line for a known language", () => {
    const lines = highlightToLines("const a = 1;\nreturn a;", "src/x.js");
    expect(lines).toHaveLength(2);
    expect(Array.isArray(lines[0])).toBe(true);
  });

  it("keeps empty lines aligned", () => {
    const lines = highlightToLines("a\n\nb", "x.py");
    expect(lines).toHaveLength(3);
  });

  it("returns null for unknown extensions and empty input", () => {
    expect(highlightToLines("hello", "file.xyzunknown")).toBeNull();
    expect(highlightToLines("", "x.js")).toBeNull();
    expect(highlightToLines("x", null)).toBeNull();
  });
});
