import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { killWorker, type KillWorkerDeps } from "../use-cases/KillWorker.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

type WtRef = { repoRoot: string; worktreeDir: string | null; branch: string };

function buildDeps(rows: Record<string, Partial<WorkerRow>>, children: Record<string, string[]> = {}): {
  deps: KillWorkerDeps;
  cleanupCalls: WtRef[];
  deleted: string[];
} {
  const cleanupCalls: WtRef[] = [];
  const deleted: string[] = [];

  const workers = {
    findById: (id: string) => (rows[id] ? ({ id, state: "IDLE", ...rows[id] } as WorkerRow) : null),
    findChildrenIds: (id: string) => children[id] ?? [],
    delete: (id: string) => { deleted.push(id); },
  } as unknown as KillWorkerDeps["workers"];

  const deps = {
    workers,
    events: { deleteByWorker: () => {} } as unknown as KillWorkerDeps["events"],
    pending: { deleteByWorker: () => {} } as unknown as KillWorkerDeps["pending"],
    bus: { publish: () => {} } as unknown as KillWorkerDeps["bus"],
    supervisor: {
      has: () => false,
      escalateKill: () => {},
      killPid: () => {},
    } as unknown as KillWorkerDeps["supervisor"],
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log } as unknown as KillWorkerDeps["log"],
    findOrphanPids: () => [],
    postKillCleanup: () => {},
    cleanupWorktree: (ref: WtRef) => { cleanupCalls.push(ref); },
    killGracePeriodMs: 2000,
  } as unknown as KillWorkerDeps;

  return { deps, cleanupCalls, deleted };
}

describe("killWorker — worktree cleanup", () => {
  it("fires cleanupWorktree once, AFTER the grace window, with the captured ref", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps, cleanupCalls } = buildDeps({
        w1: { worktree_from: "/repo", worktree_dir: "/repo/.claude-mgr/worktrees/cm-w1-x", branch: "cm-w1-x" },
      });
      killWorker(deps, "w1");
      // Deferred: nothing until the grace elapses (the PTY child is still dying).
      assert.equal(cleanupCalls.length, 0);
      mock.timers.tick(2000);
      assert.deepEqual(cleanupCalls, [
        { repoRoot: "/repo", worktreeDir: "/repo/.claude-mgr/worktrees/cm-w1-x", branch: "cm-w1-x" },
      ]);
    } finally {
      mock.timers.reset();
    }
  });

  it("skips a plain-cwd worker (no worktree_from / branch)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps, cleanupCalls, deleted } = buildDeps({ w1: { cwd: "/some/dir" } });
      killWorker(deps, "w1");
      mock.timers.tick(2000);
      assert.equal(cleanupCalls.length, 0);
      assert.deepEqual(deleted, ["w1"]);
    } finally {
      mock.timers.reset();
    }
  });

  it("derives a null worktreeDir when not yet persisted", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps, cleanupCalls } = buildDeps({
        w1: { worktree_from: "/repo", branch: "cm-w1-x" }, // worktree_dir absent
      });
      killWorker(deps, "w1");
      mock.timers.tick(2000);
      assert.deepEqual(cleanupCalls, [{ repoRoot: "/repo", worktreeDir: null, branch: "cm-w1-x" }]);
    } finally {
      mock.timers.reset();
    }
  });

  it("cleans the whole subtree — parent + worktree child (depth-first recursion)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps, cleanupCalls } = buildDeps(
        {
          parent: { worktree_from: "/repo", branch: "cm-parent-a" },
          child: { worktree_from: "/repo", branch: "cm-child-b" },
        },
        { parent: ["child"] },
      );
      killWorker(deps, "parent");
      mock.timers.tick(2000);
      const branches = cleanupCalls.map((r) => r.branch).sort();
      assert.deepEqual(branches, ["cm-child-b", "cm-parent-a"]);
    } finally {
      mock.timers.reset();
    }
  });
});
