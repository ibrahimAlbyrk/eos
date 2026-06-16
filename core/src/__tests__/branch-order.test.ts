import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { orderBranches } from "../domain/branch-order.ts";

describe("orderBranches", () => {
  it("orders by the usage signal (most-recently-used first)", () => {
    const branches = ["feature-b", "main", "feature-a"];
    const usage = ["feature-a", "main", "feature-b"];
    assert.deepEqual(orderBranches(branches, usage, "feature-a"), ["feature-a", "main", "feature-b"]);
  });

  it("drops branches absent from usage to a stable alphabetical tail", () => {
    const branches = ["zzz", "main", "aaa", "feature"];
    const usage = ["main", "feature"];
    assert.deepEqual(orderBranches(branches, usage, "main"), ["main", "feature", "aaa", "zzz"]);
  });

  it("falls back to alphabetical when usage is empty and HEAD is detached", () => {
    const branches = ["main", "dev", "release", "alpha"];
    assert.deepEqual(orderBranches(branches, [], null), ["alpha", "dev", "main", "release"]);
  });

  it("never buries the current branch even when usage hasn't seen it", () => {
    // Fresh worktree: HEAD on feature-new, but its reflog has no checkout entry.
    const branches = ["main", "dev", "feature-new"];
    const usage = ["main", "dev"];
    assert.deepEqual(orderBranches(branches, usage, "feature-new"), ["feature-new", "main", "dev"]);
  });

  it("ignores usage entries for branches that no longer exist", () => {
    const branches = ["main", "dev"];
    const usage = ["deleted-branch", "dev", "main"];
    assert.deepEqual(orderBranches(branches, usage, "dev"), ["dev", "main"]);
  });

  it("is duplicate-proof: the first (most-recent) sighting wins", () => {
    const branches = ["a", "b", "c"];
    const usage = ["c", "a", "c", "b"];
    assert.deepEqual(orderBranches(branches, usage, null), ["c", "a", "b"]);
  });

  it("does not mutate the input array", () => {
    const branches = ["b", "a"];
    orderBranches(branches, ["a"], null);
    assert.deepEqual(branches, ["b", "a"]);
  });
});
