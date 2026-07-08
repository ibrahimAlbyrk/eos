import { describe, it, expect } from "vitest";
import { repoRootForPath } from "./symbolRoot.js";

const w = (fields) => ({ id: "x", ...fields });

describe("repoRootForPath", () => {
  it("returns the containing worker's worktree/cwd", () => {
    const workers = [w({ cwd: "/repo" })];
    expect(repoRootForPath("/repo/src/a.ts", workers)).toBe("/repo");
  });

  it("prefers worktree_dir over cwd", () => {
    const workers = [w({ cwd: "/repo", worktree_dir: "/wt/iso" })];
    expect(repoRootForPath("/wt/iso/src/a.ts", workers)).toBe("/wt/iso");
  });

  it("picks the longest (most specific) containing root", () => {
    const workers = [w({ cwd: "/repo" }), w({ cwd: "/repo/sub" })];
    expect(repoRootForPath("/repo/sub/a.ts", workers)).toBe("/repo/sub");
  });

  it("does not match a sibling dir sharing a name prefix", () => {
    const workers = [w({ cwd: "/repo-two" })];
    expect(repoRootForPath("/repo/a.ts", workers)).toBe(null);
  });

  it("returns null on no match or bad input", () => {
    expect(repoRootForPath("/other/a.ts", [w({ cwd: "/repo" })])).toBe(null);
    expect(repoRootForPath(null, [])).toBe(null);
    expect(repoRootForPath("/a", null)).toBe(null);
  });
});
