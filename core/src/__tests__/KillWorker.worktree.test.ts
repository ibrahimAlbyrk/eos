import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { killWorker, type KillWorkerDeps } from "../use-cases/KillWorker.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorktreeRemovalEntry } from "../ports/WorktreeRemovalQueue.ts";

const NOW = 1_000_000;

function buildDeps(rows: Record<string, Partial<WorkerRow>>, children: Record<string, string[]> = {}): {
  deps: KillWorkerDeps;
  enqueued: WorktreeRemovalEntry[];
  deleted: string[];
} {
  const enqueued: WorktreeRemovalEntry[] = [];
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
    clock: { now: () => NOW } as unknown as KillWorkerDeps["clock"],
    worktreeRemovals: {
      enqueue: (e: WorktreeRemovalEntry) => { enqueued.push(e); },
      list: () => [],
      delete: () => {},
    } as unknown as KillWorkerDeps["worktreeRemovals"],
    findOrphanPids: () => [],
    postKillCleanup: () => {},
    killGracePeriodMs: 2000,
  } as unknown as KillWorkerDeps;

  return { deps, enqueued, deleted };
}

describe("killWorker — worktree cleanup", () => {
  it("enqueues a durable removal (synchronously) with the captured ref + scheduledAt = now + grace", () => {
    const { deps, enqueued } = buildDeps({
      w1: { worktree_from: "/repo", worktree_dir: "/repo/.eos/worktrees/eos-w1-x", branch: "eos-w1-x" },
    });
    killWorker(deps, "w1");
    assert.deepEqual(enqueued, [
      { id: "w1", workerId: "w1", repoRoot: "/repo", worktreeDir: "/repo/.eos/worktrees/eos-w1-x", branch: "eos-w1-x", scheduledAt: NOW + 2000 },
    ]);
  });

  it("skips a plain-cwd worker (no worktree_from / branch)", () => {
    const { deps, enqueued, deleted } = buildDeps({ w1: { cwd: "/some/dir" } });
    killWorker(deps, "w1");
    assert.equal(enqueued.length, 0);
    assert.deepEqual(deleted, ["w1"]);
  });

  it("enqueues a null worktreeDir when not yet persisted", () => {
    const { deps, enqueued } = buildDeps({
      w1: { worktree_from: "/repo", branch: "eos-w1-x" }, // worktree_dir absent
    });
    killWorker(deps, "w1");
    assert.deepEqual(enqueued, [
      { id: "w1", workerId: "w1", repoRoot: "/repo", worktreeDir: null, branch: "eos-w1-x", scheduledAt: NOW + 2000 },
    ]);
  });

  it("enqueues the whole subtree — parent + worktree child (depth-first recursion)", () => {
    const { deps, enqueued } = buildDeps(
      {
        parent: { worktree_from: "/repo", branch: "eos-parent-a" },
        child: { worktree_from: "/repo", branch: "eos-child-b" },
      },
      { parent: ["child"] },
    );
    killWorker(deps, "parent");
    const branches = enqueued.map((e) => e.branch).sort();
    assert.deepEqual(branches, ["eos-child-b", "eos-parent-a"]);
  });
});

describe("killWorker — adopted leak cleanups (optional deps)", () => {
  it("cleans loop rows + the conversation transcript when the optional deps are wired", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps } = buildDeps({ w1: { session_id: "sess-1" } });
      const loopDeletes: string[] = [];
      const convDeletes: string[] = [];
      deps.loops = { deleteByWorker: (id: string) => { loopDeletes.push(id); } };
      deps.deleteConversation = (sessionId: string) => { convDeletes.push(sessionId); };
      killWorker(deps, "w1");
      assert.deepEqual(loopDeletes, ["w1"]);
      assert.deepEqual(convDeletes, ["sess-1"]);
    } finally {
      mock.timers.reset();
    }
  });

  it("skips the conversation delete for a row without session_id; absent deps stay a no-op", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps, deleted } = buildDeps({ w1: {} });
      const convDeletes: string[] = [];
      deps.deleteConversation = (sessionId: string) => { convDeletes.push(sessionId); };
      killWorker(deps, "w1"); // loops absent entirely — must not throw
      assert.deepEqual(convDeletes, []);
      assert.deepEqual(deleted, ["w1"]);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("killWorker — archived rows (compat path)", () => {
  it("still cascades an archived row; process stop no-ops on the dead process", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps, enqueued, deleted } = buildDeps({
        w1: { state: "DONE", archived_at: 500, pid: null, worktree_from: "/repo", branch: "eos-w1-x" },
      });
      const res = killWorker(deps, "w1");
      assert.deepEqual(res.killed, []);
      assert.deepEqual(deleted, ["w1"]);
      assert.equal(enqueued.length, 1);
    } finally {
      mock.timers.reset();
    }
  });
});

describe("killWorker — result identity (durable name for the transcript)", () => {
  it("returns the worker id and name so a killed-worker tool row stays named", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps } = buildDeps({ w1: { name: "refactor-auth", state: "WORKING" } });
      const res = killWorker(deps, "w1");
      assert.equal(res.id, "w1");
      assert.equal(res.name, "refactor-auth");
      assert.equal(res.wasState, "WORKING");
    } finally {
      mock.timers.reset();
    }
  });

  it("returns name null when the worker had no name", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { deps } = buildDeps({ w1: {} });
      const res = killWorker(deps, "w1");
      assert.equal(res.id, "w1");
      assert.equal(res.name, null);
    } finally {
      mock.timers.reset();
    }
  });
});
