import { describe, it, expect } from "vitest";
import { flattenVisible } from "./explorerNodes.js";

const entry = (name, type) => ({ name, type, absolutePath: `/root/${name}`, relativePath: name });
const ready = (entries) => ({ state: "ready", entries });

describe("flattenVisible", () => {
  it("shows a loading marker for an uncached root, nothing for a null root", () => {
    const out = flattenVisible("/root", new Set(), new Map());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "loading", depth: 0 });
    expect(flattenVisible(null, new Set(), new Map())).toEqual([]);
  });

  it("lists root children dirs-first at depth 0", () => {
    const cache = new Map([["/root", ready([entry("src", "directory"), entry("a.txt", "file")])]]);
    const out = flattenVisible("/root", new Set(), cache);
    expect(out.map((n) => [n.name, n.depth])).toEqual([["src", 0], ["a.txt", 0]]);
    expect(out[0]).toMatchObject({ kind: "entry", expandable: true });
    expect(out[1]).toMatchObject({ expandable: false });
  });

  it("splices an expanded dir's children at depth+1", () => {
    const cache = new Map([
      ["/root", ready([{ name: "src", type: "directory", absolutePath: "/root/src", relativePath: "src" }])],
      ["/root/src", ready([{ name: "x.js", type: "file", absolutePath: "/root/src/x.js", relativePath: "src/x.js" }])],
    ]);
    const out = flattenVisible("/root", new Set(["/root/src"]), cache);
    expect(out.map((n) => [n.name, n.depth])).toEqual([["src", 0], ["x.js", 1]]);
  });

  it("does not descend into a collapsed dir", () => {
    const cache = new Map([
      ["/root", ready([{ name: "src", type: "directory", absolutePath: "/root/src", relativePath: "src" }])],
      ["/root/src", ready([{ name: "x.js", type: "file", absolutePath: "/root/src/x.js", relativePath: "src/x.js" }])],
    ]);
    const out = flattenVisible("/root", new Set(), cache); // src not expanded
    expect(out.map((n) => n.name)).toEqual(["src"]);
  });

  it("emits a marker row for an expanded dir that is loading or empty", () => {
    const cache = new Map([
      ["/root", ready([
        { name: "loadingDir", type: "directory", absolutePath: "/root/loadingDir", relativePath: "loadingDir" },
        { name: "emptyDir", type: "directory", absolutePath: "/root/emptyDir", relativePath: "emptyDir" },
      ])],
      ["/root/loadingDir", { state: "loading", entries: [] }],
      ["/root/emptyDir", ready([])],
    ]);
    const out = flattenVisible("/root", new Set(["/root/loadingDir", "/root/emptyDir"]), cache);
    expect(out.map((n) => n.kind)).toEqual(["entry", "loading", "entry", "empty"]);
  });
});
