import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reapWorktreeRemovals, type ReapWorktreeRemovalsDeps } from "../use-cases/ReapWorktreeRemovals.ts";
import type { WorktreeRemovalEntry } from "../ports/WorktreeRemovalQueue.ts";
import type { WorktreeRef } from "../ports/WorktreeManager.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

const NOW = 1_000_000;

function build(opts: {
  entries: WorktreeRemovalEntry[];
  rows?: Partial<WorkerRow>[];
  remove?: (ref: WorktreeRef) => Promise<{ removed: boolean; reason?: string }>;
  listAllThrows?: boolean;
}): {
  deps: ReapWorktreeRemovalsDeps;
  queue: Map<string, WorktreeRemovalEntry>;
  removed: WorktreeRef[];
  snapshotsCleaned: string[];
} {
  const queue = new Map(opts.entries.map((e) => [e.id, e]));
  const removed: WorktreeRef[] = [];
  const snapshotsCleaned: string[] = [];
  const deps = {
    queue: {
      enqueue: (e: WorktreeRemovalEntry) => { queue.set(e.id, e); },
      list: () => [...queue.values()],
      delete: (id: string) => { queue.delete(id); },
    },
    workers: {
      listAll: () => {
        if (opts.listAllThrows) throw new Error("boom");
        return (opts.rows ?? []) as WorkerRow[];
      },
    },
    worktrees: {
      remove: opts.remove ?? (async (ref: WorktreeRef) => { removed.push(ref); return { removed: true }; }),
      listWorktrees: async () => [],
    },
    branchIntegration: {
      cleanupSnapshot: async ({ workerId }: { repoRoot: string; workerId: string }) => { snapshotsCleaned.push(workerId); },
    },
    clock: { now: () => NOW },
    log: { info: () => {}, warn: () => {}, error: () => {}, child: () => deps.log },
  } as unknown as ReapWorktreeRemovalsDeps;
  return { deps, queue, removed, snapshotsCleaned };
}

const entry = (over: Partial<WorktreeRemovalEntry> = {}): WorktreeRemovalEntry => ({
  id: "w1", workerId: "w1", repoRoot: "/repo", worktreeDir: "/repo/.eos/worktrees/eos-w1", branch: "eos-w1", scheduledAt: NOW - 1, ...over,
});

describe("reapWorktreeRemovals", () => {
  it("removes a due, non-shared worktree, cleans its snapshot, and drops the entry", async () => {
    const { deps, queue, removed, snapshotsCleaned } = build({ entries: [entry()] });
    await reapWorktreeRemovals(deps);
    assert.deepEqual(removed.map((r) => r.branch), ["eos-w1"]);
    assert.deepEqual(snapshotsCleaned, ["w1"]);
    assert.equal(queue.size, 0);
  });

  it("skips an entry whose grace has not elapsed (scheduledAt > now)", async () => {
    const { deps, queue, removed } = build({ entries: [entry({ scheduledAt: NOW + 5000 })] });
    await reapWorktreeRemovals(deps);
    assert.equal(removed.length, 0);
    assert.equal(queue.size, 1); // retained until due
  });

  it("keeps a shared worktree (a live row still references branch+repoRoot) but consumes the entry", async () => {
    const { deps, queue, removed } = build({
      entries: [entry()],
      rows: [{ branch: "eos-w1", worktree_from: "/repo" }],
    });
    await reapWorktreeRemovals(deps);
    assert.equal(removed.length, 0);
    assert.equal(queue.size, 0);
  });

  it("consumes a permanently-unremovable entry (remove → removed:false) instead of retrying forever", async () => {
    const { deps, queue } = build({ entries: [entry()], remove: async () => ({ removed: false, reason: "no branch" }) });
    await reapWorktreeRemovals(deps);
    assert.equal(queue.size, 0);
  });

  it("retains the entry for the next tick when a step throws", async () => {
    const { deps, queue } = build({ entries: [entry()], listAllThrows: true });
    await reapWorktreeRemovals(deps);
    assert.equal(queue.size, 1);
  });
});
