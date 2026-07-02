import { describe, it, expect } from "vitest";
import { groupByFile, relToRoot, kindGlyph } from "./symbols.js";

const occ = (path, line, extra = {}) => ({ name: "foo", kind: "function", role: "reference", path, line, column: 1, ...extra });

describe("groupByFile", () => {
  it("groups occurrences by path preserving file + item order", () => {
    const groups = groupByFile([
      occ("/r/a.ts", 3), occ("/r/b.ts", 1), occ("/r/a.ts", 9),
    ]);
    expect(groups.map((g) => g.path)).toEqual(["/r/a.ts", "/r/b.ts"]);
    expect(groups[0].items.map((o) => o.line)).toEqual([3, 9]);
    expect(groups[1].items).toHaveLength(1);
  });

  it("handles empty / null input", () => {
    expect(groupByFile([])).toEqual([]);
    expect(groupByFile(null)).toEqual([]);
  });
});

describe("relToRoot", () => {
  it("strips the root prefix when the path is under root", () => {
    expect(relToRoot("/r/src/x.ts", "/r")).toBe("src/x.ts");
  });
  it("falls back to the basename when outside root", () => {
    expect(relToRoot("/other/x.ts", "/r")).toBe("x.ts");
    expect(relToRoot("/other/x.ts", null)).toBe("x.ts");
  });
});

describe("kindGlyph", () => {
  it("maps known kinds and falls back for unknown", () => {
    expect(kindGlyph("function")).toBe("ƒ");
    expect(kindGlyph("class")).toBe("◆");
    expect(kindGlyph("nonsense")).toBe("•");
    expect(kindGlyph(undefined)).toBe("•");
  });
});
