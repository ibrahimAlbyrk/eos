import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pruneOrphanWorktrees, type PruneOrphanWorktreesDeps } from "../use-cases/PruneOrphanWorktrees.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorktreeEntry } from "../ports/WorktreeManager.ts";

function buildDeps(rows: Partial<WorkerRow>[], entries: Record<string, WorktreeEntry[]>): {
  deps: PruneOrphanWorktreesDeps;
  removed: string[];
} {
  const removed: string[] = [];
  const deps = {
    workers: { listAll: () => rows as WorkerRow[] },
    worktrees: {
      listWorktrees: async (repoRoot: string) => entries[repoRoot] ?? [],
      remove: async (ref: { branch: string }) => { removed.push(ref.branch); return { removed: true }; },
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log },
  } as unknown as PruneOrphanWorktreesDeps;
  return { deps, removed };
}

const wt = (over: Partial<WorktreeEntry>): WorktreeEntry => ({
  path: "/repo/.claude-mgr/worktrees/cm-x", branch: "cm-x", locked: false, isMain: false, ...over,
});

describe("pruneOrphanWorktrees", () => {
  it("removes ONLY a row-gone, unlocked, cm-*, under-.claude-mgr worktree", async () => {
    const { deps, removed } = buildDeps(
      [{ worktree_from: "/repo", branch: "cm-live-1" }], // one live worker
      {
        "/repo": [
          wt({ path: "/repo", branch: "main", isMain: true }), // main → skip
          wt({ path: "/repo/.claude-mgr/worktrees/cm-live-1", branch: "cm-live-1" }), // live → skip
          wt({ path: "/repo/.claude-mgr/worktrees/cm-gone-2", branch: "cm-gone-2" }), // ORPHAN → remove
          wt({ path: "/repo/.claude-mgr/worktrees/cm-lock-3", branch: "cm-lock-3", locked: true }), // locked → skip
          wt({ path: "/repo/.claude-mgr/worktrees/feat-4", branch: "feature/4" }), // non-cm → skip
          wt({ path: "/elsewhere/cm-stray-5", branch: "cm-stray-5" }), // not under managed tree → skip
        ],
      },
    );
    await pruneOrphanWorktrees(deps);
    assert.deepEqual(removed, ["cm-gone-2"]);
  });

  it("refuses to prune a repo that has a worktree worker with no recorded branch (transition guard)", async () => {
    const { deps, removed } = buildDeps(
      [{ worktree_from: "/repo", branch: null }], // pre-fix ambiguous row
      {
        "/repo": [
          wt({ path: "/repo/.claude-mgr/worktrees/cm-gone-2", branch: "cm-gone-2" }),
        ],
      },
    );
    await pruneOrphanWorktrees(deps);
    assert.deepEqual(removed, []);
  });

  it("does nothing when there are no worktree workers", async () => {
    const { deps, removed } = buildDeps([{ cwd: "/x" }], {});
    await pruneOrphanWorktrees(deps);
    assert.deepEqual(removed, []);
  });
});
