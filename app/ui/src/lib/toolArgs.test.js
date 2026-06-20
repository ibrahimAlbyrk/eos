import { describe, it, expect } from "vitest";
import { argsSummary } from "./toolArgs.js";

describe("argsSummary", () => {
  it("prefers a salient key in priority order", () => {
    expect(argsSummary({ file_path: "/a/b.ts", query: "x" })).toBe("/a/b.ts");
    expect(argsSummary({ query: "find me", tokens: 4000 })).toBe("find me");
  });

  it("falls back to the first short scalar value", () => {
    expect(argsSummary({ libraryId: "/vercel/next.js" })).toBe("/vercel/next.js");
  });

  it("clamps long values to ~60 chars", () => {
    const long = "x".repeat(200);
    const out = argsSummary({ command: long });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("collapses whitespace", () => {
    expect(argsSummary({ command: "git   commit\n -m x" })).toBe("git commit -m x");
  });

  it("returns empty for no usable scalar", () => {
    expect(argsSummary({})).toBe("");
    expect(argsSummary(null)).toBe("");
    expect(argsSummary({ nested: { a: 1 } })).toBe("");
  });

  it("skips overly long non-salient strings", () => {
    expect(argsSummary({ blob: "y".repeat(120) })).toBe("");
  });
});
