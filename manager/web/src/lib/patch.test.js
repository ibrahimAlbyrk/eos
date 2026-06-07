import { describe, it, expect } from "vitest";
import { parsePatch } from "./patch.js";

const SINGLE = `diff --git a/a.txt b/a.txt
index 1234567..89abcde 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 one
-two
+TWO
+extra
 three
`;

describe("parsePatch", () => {
  it("parses a single hunk with correct line numbers", () => {
    const hunks = parsePatch(SINGLE);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -1,3 +1,4 @@");
    expect(hunks[0].rows).toEqual([
      { type: "ctx", num: 1, text: "one" },
      { type: "del", num: 2, text: "two" },
      { type: "add", num: 2, text: "TWO" },
      { type: "add", num: 3, text: "extra" },
      { type: "ctx", num: 4, text: "three" },
    ]);
  });

  it("parses multiple hunks", () => {
    const patch = "@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,2 @@\n c\n+d\n";
    const hunks = parsePatch(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[1].rows).toEqual([
      { type: "ctx", num: 10, text: "c" },
      { type: "add", num: 11, text: "d" },
    ]);
  });

  it("skips '\\ No newline at end of file' markers", () => {
    const patch = "@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n";
    const rows = parsePatch(patch)[0].rows;
    expect(rows.map((r) => r.type)).toEqual(["del", "add"]);
  });

  it("handles new-file patches (no old lines)", () => {
    const patch = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n@@ -0,0 +1,2 @@\n+hello\n+world\n";
    const rows = parsePatch(patch)[0].rows;
    expect(rows).toEqual([
      { type: "add", num: 1, text: "hello" },
      { type: "add", num: 2, text: "world" },
    ]);
  });

  it("returns [] for empty or header-only input", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch(null)).toEqual([]);
    expect(parsePatch("diff --git a/x b/x\nindex 1..2 100644\n")).toEqual([]);
  });

  it("does not emit a phantom row for the trailing newline", () => {
    const rows = parsePatch("@@ -1,1 +1,1 @@\n-a\n+b\n")[0].rows;
    expect(rows).toHaveLength(2);
  });

  it("keeps hunk context text after @@ in the header", () => {
    const hunks = parsePatch("@@ -4,2 +4,2 @@ function foo() {\n-a\n+b\n");
    expect(hunks[0].header).toBe("@@ -4,2 +4,2 @@ function foo() {");
  });
});
