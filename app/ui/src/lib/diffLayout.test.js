import { describe, it, expect } from "vitest";
import { parsePatch } from "./patch.js";
import { foldGaps, splitPairs } from "./diffLayout.js";

const PATCH = "@@ -3,3 +3,4 @@ function solve()\n ctx\n-old\n+new\n+extra\n ctx2\n@@ -20,2 +21,2 @@\n-a\n+b\n c\n";

describe("diffLayout", () => {
  it("keeps hunk ranges and function context", () => {
    const [h] = parsePatch(PATCH);
    expect(h).toMatchObject({ oldStart: 3, oldCount: 3, newStart: 3, newCount: 4, context: "function solve()" });
    expect(parsePatch("@@ -1 +1 @@\n-a\n+b\n")[0]).toMatchObject({ oldCount: 1, newCount: 1, context: "" });
  });

  it("finds the unchanged lines git left out before each hunk", () => {
    expect(foldGaps(parsePatch(PATCH))).toEqual([{ start: 1, end: 2 }, { start: 7, end: 20 }]);
    expect(foldGaps(parsePatch("@@ -0,0 +1,2 @@\n+a\n+b\n"))).toEqual([null]);
  });

  it("pairs deletions with the additions after them for split view", () => {
    const pairs = splitPairs(parsePatch(PATCH)[0]);
    const view = pairs.map((p) => [p.left?.row.text ?? null, p.left?.num ?? null, p.right?.row.text ?? null, p.right?.num ?? null]);
    expect(view).toEqual([
      ["ctx", 3, "ctx", 3],
      ["old", 4, "new", 4],
      [null, null, "extra", 5],
      ["ctx2", 5, "ctx2", 6],
    ]);
  });
});
