import { describe, it, expect } from "vitest";
import { buildFileTree } from "./buildFileTree.js";

const F = (path, over = {}) => ({ path, status: "M", insertions: 1, deletions: 2, untracked: false, ...over });

describe("buildFileTree", () => {
  it("returns an empty list for no files", () => {
    expect(buildFileTree([])).toEqual([]);
    expect(buildFileTree(undefined)).toEqual([]);
  });

  it("nests files under their dirs and keeps root files at top level", () => {
    const tree = buildFileTree([F("src/a.ts"), F("README.md")]);
    expect(tree.map((n) => [n.type, n.label])).toEqual([["dir", "src"], ["file", "README.md"]]);
    expect(tree[0].children.map((n) => n.label)).toEqual(["a.ts"]);
    expect(tree[0].children[0].path).toBe("src/a.ts");
  });

  it("compresses single-child dir chains into one labeled row", () => {
    const tree = buildFileTree([F("src/views/code/a.ts"), F("src/views/code/b.ts")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("src/views/code");
    expect(tree[0].path).toBe("src/views/code");
    expect(tree[0].children.map((n) => n.label)).toEqual(["a.ts", "b.ts"]);
  });

  it("stops compressing where a dir has files or forks", () => {
    const tree = buildFileTree([F("src/lib/x.ts"), F("src/hooks/y.ts"), F("src/z.ts")]);
    expect(tree[0].label).toBe("src");
    expect(tree[0].children.map((n) => n.label)).toEqual(["hooks", "lib", "z.ts"]);
  });

  it("aggregates insertions/deletions bottom-up", () => {
    const tree = buildFileTree([
      F("src/a.ts", { insertions: 3, deletions: 1 }),
      F("src/deep/b.ts", { insertions: 5, deletions: 2 }),
    ]);
    expect(tree[0].ins).toBe(8);
    expect(tree[0].del).toBe(3);
    const deep = tree[0].children.find((n) => n.type === "dir");
    expect([deep.ins, deep.del]).toEqual([5, 2]);
  });

  it("skips null counts of binary files and flags hasBinary up the chain", () => {
    const tree = buildFileTree([
      F("assets/img/logo.png", { insertions: null, deletions: null }),
      F("assets/notes.txt", { insertions: 2, deletions: 0 }),
    ]);
    expect(tree[0].label).toBe("assets");
    expect([tree[0].ins, tree[0].del, tree[0].hasBinary]).toEqual([2, 0, true]);
    const img = tree[0].children.find((n) => n.type === "dir");
    expect(img.hasBinary).toBe(true);
    expect([img.ins, img.del]).toEqual([0, 0]);
  });

  it("sorts dirs first, then files, both alphabetical", () => {
    const tree = buildFileTree([F("b.ts"), F("a.ts"), F("zdir/x.ts"), F("adir/y.ts")]);
    expect(tree.map((n) => [n.type, n.label])).toEqual([
      ["dir", "adir"], ["dir", "zdir"], ["file", "a.ts"], ["file", "b.ts"],
    ]);
  });

  it("keys a renamed file by its new path and carries the file row through", () => {
    const renamed = F("src/new.ts", { status: "R", oldPath: "src/old.ts" });
    const tree = buildFileTree([renamed]);
    const leaf = tree[0].children[0];
    expect(leaf.path).toBe("src/new.ts");
    expect(leaf.file).toBe(renamed);
    expect(tree[0].children).toHaveLength(1);
  });
});
