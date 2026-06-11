import { describe, it, expect } from "vitest";
import { highlightToTokenLines } from "./highlightTokens.js";

describe("highlightToTokenLines", () => {
  it("returns one token-array per line for a known language", () => {
    const lines = highlightToTokenLines("const a = 1;\nreturn a;", "src/x.js");
    expect(lines).toHaveLength(2);
    expect(Array.isArray(lines[0])).toBe(true);
  });

  it("emits serializable {t, c} tokens with palette classes", () => {
    const lines = highlightToTokenLines("const a = 1;", "x.js");
    const flat = lines.flat();
    expect(flat.every((tok) => typeof tok.t === "string")).toBe(true);
    expect(flat.some((tok) => tok.c === "hlc-keyword")).toBe(true);
  });

  it("keeps empty lines aligned", () => {
    const lines = highlightToTokenLines("a\n\nb", "x.py");
    expect(lines).toHaveLength(3);
  });

  it("returns null for unknown extensions and empty input", () => {
    expect(highlightToTokenLines("hello", "file.xyzunknown")).toBeNull();
    expect(highlightToTokenLines("", "x.js")).toBeNull();
    expect(highlightToTokenLines("x", null)).toBeNull();
  });
});
