import { describe, it, expect } from "vitest";
import { agentIdAtIndex, subtreeIds, groupRootsByProject } from "./tree.js";

const w = (id, parent_id = null, started_at = 0) => ({ id, parent_id, started_at });

const workers = [
  w("orchB", null, 2000),
  w("workerA2", "orchA", 1200),
  w("orchA", null, 1000),
  w("workerA1", "orchA", 1100),
  w("workerB1", "orchB", 2100),
];

const none = new Set();

describe("agentIdAtIndex", () => {
  it("indexes depth-first in started_at order", () => {
    expect(agentIdAtIndex(workers, none, 0)).toBe("orchA");
    expect(agentIdAtIndex(workers, none, 1)).toBe("workerA1");
    expect(agentIdAtIndex(workers, none, 2)).toBe("workerA2");
    expect(agentIdAtIndex(workers, none, 3)).toBe("orchB");
    expect(agentIdAtIndex(workers, none, 4)).toBe("workerB1");
  });

  it("skips children of collapsed nodes", () => {
    const collapsed = new Set(["orchA"]);
    expect(agentIdAtIndex(workers, collapsed, 0)).toBe("orchA");
    expect(agentIdAtIndex(workers, collapsed, 1)).toBe("orchB");
    expect(agentIdAtIndex(workers, collapsed, 2)).toBe("workerB1");
  });

  it("returns null when index is out of range", () => {
    expect(agentIdAtIndex(workers, none, 5)).toBeNull();
    expect(agentIdAtIndex([], none, 0)).toBeNull();
  });
});

describe("subtreeIds", () => {
  const deep = [...workers, w("subA1a", "workerA1", 1150)];

  it("collects the root and all descendants", () => {
    expect(new Set(subtreeIds(deep, "orchA"))).toEqual(
      new Set(["orchA", "workerA1", "workerA2", "subA1a"]),
    );
  });

  it("returns just the id for a leaf", () => {
    expect(subtreeIds(deep, "workerB1")).toEqual(["workerB1"]);
  });

  it("ignores unrelated branches", () => {
    expect(subtreeIds(deep, "orchB")).toEqual(["orchB", "workerB1"]);
  });
});

describe("groupRootsByProject", () => {
  const root = (id, cwd, worktree_from = null) => ({ id, cwd, worktree_from });

  it("groups roots by project dir and names groups by basename", () => {
    const groups = groupRootsByProject([
      root("a", "/Users/me/claude-manager"),
      root("b", "/Users/me/dear-souls"),
      root("c", "/Users/me/claude-manager"),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["claude-manager", "dear-souls"]);
    expect(groups[0].path).toBe("/Users/me/claude-manager");
    expect(groups[0].roots.map((r) => r.id)).toEqual(["a", "c"]);
    expect(groups[1].roots.map((r) => r.id)).toEqual(["b"]);
  });

  it("prefers worktree_from over cwd for the project key", () => {
    const groups = groupRootsByProject([
      root("a", "/tmp/worktrees/x", "/Users/me/proj"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("proj");
    expect(groups[0].path).toBe("/Users/me/proj");
  });

  it("buckets roots with no project under 'Other', always last", () => {
    const groups = groupRootsByProject([
      root("a", null),
      root("b", "/Users/me/proj"),
      root("c", null),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["proj", "Other"]);
    const other = groups[groups.length - 1];
    expect(other.path).toBeNull();
    expect(other.roots.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("keeps group order by first appearance (stable, no churn)", () => {
    const groups = groupRootsByProject([
      root("a", "/p/second"),
      root("b", "/p/first"),
      root("c", "/p/second"),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["second", "first"]);
  });
});
