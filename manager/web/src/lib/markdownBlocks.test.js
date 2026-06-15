import { describe, it, expect } from "vitest";
import { listMarkers, listContinuation, listIndent } from "./markdownBlocks.js";

describe("listMarkers", () => {
  it("returns nothing for plain text", () => {
    expect(listMarkers("hello world")).toEqual([]);
  });

  it("finds an unordered marker at line start (glyph only, no trailing space)", () => {
    expect(listMarkers("- item")).toEqual([{ start: 0, end: 1, depth: 0, ordered: false }]);
  });

  it("derives depth from 2-space indentation and reports ordered markers", () => {
    const text = "- a\n  - b\n1. c";
    expect(listMarkers(text)).toEqual([
      { start: 0, end: 1, depth: 0, ordered: false },
      { start: 6, end: 7, depth: 1, ordered: false },
      { start: 10, end: 12, depth: 0, ordered: true },
    ]);
  });

  it("accepts *, + and ) delimiters", () => {
    expect(listMarkers("* a").map((m) => m.ordered)).toEqual([false]);
    expect(listMarkers("2) b")[0]).toMatchObject({ ordered: true, end: 2 });
  });

  it("ignores a dash with no following space", () => {
    expect(listMarkers("-nope")).toEqual([]);
  });
});

describe("listContinuation", () => {
  it("returns null off a list line", () => {
    expect(listContinuation("plain", 5)).toBeNull();
  });

  it("seeds the next bullet at the caret", () => {
    const r = listContinuation("- a", 3);
    expect(r.text).toBe("- a\n- ");
    expect(r.cursorPos).toBe(6);
  });

  it("preserves indentation for nested items", () => {
    const r = listContinuation("  - a", 5);
    expect(r.text).toBe("  - a\n  - ");
  });

  it("increments ordered markers", () => {
    expect(listContinuation("1. a", 4).text).toBe("1. a\n2. ");
  });

  it("exits the list on an empty item", () => {
    const r = listContinuation("- a\n- ", 6);
    expect(r.text).toBe("- a\n");
    expect(r.cursorPos).toBe(4);
  });
});

describe("listIndent", () => {
  it("returns null off a list line", () => {
    expect(listIndent("plain", 2, false)).toBeNull();
  });

  it("indents a list line by two spaces", () => {
    const r = listIndent("- a", 2, false);
    expect(r.text).toBe("  - a");
    expect(r.cursorPos).toBe(4);
  });

  it("outdents up to two leading spaces", () => {
    expect(listIndent("  - a", 4, true).text).toBe("- a");
  });

  it("returns null when there is nothing to outdent", () => {
    expect(listIndent("- a", 2, true)).toBeNull();
  });
});
