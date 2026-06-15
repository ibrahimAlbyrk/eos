// ReapWorktreeRemovals — drains the durable worktree-removal queue. Runs on
// daemon boot AND on an interval, so a worktree scheduled for removal is
// reclaimed even if the daemon died (SIGKILL on eos restart/build) before the
// old in-memory grace timer could fire. The shared-workspace check lives here,
// not at enqueue time: by the time an entry is due its worker row is gone, so a
// row still referencing the branch means a live attach-mode worker is using the
// tree and it must be kept.
//
// Idempotent + retry-safe: WorktreeManager.remove never throws and treats an
// already-gone tree as removed, so a double tick (boot + interval overlap) is
// harmless; an entry is dropped once handled, kept for the next tick on throw.

import type { WorktreeRemovalQueue } from "../ports/WorktreeRemovalQueue.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { WorktreeManager } from "../ports/WorktreeManager.ts";
import type { BranchIntegration } from "../ports/BranchIntegration.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";

export interface ReapWorktreeRemovalsDeps {
  queue: WorktreeRemovalQueue;
  workers: WorkerRepo;
  worktrees: WorktreeManager;
  branchIntegration: Pick<BranchIntegration, "cleanupSnapshot">;
  clock: Clock;
  log: Logger;
}

export async function reapWorktreeRemovals(deps: ReapWorktreeRemovalsDeps): Promise<void> {
  const now = deps.clock.now();
  for (const e of deps.queue.list()) {
    if (e.scheduledAt > now) continue; // grace not elapsed — the cwd may still be live
    try {
      // The deleted worker's try snapshot lives outside the worktree and is
      // dropped regardless of whether the tree itself is shared/kept.
      await deps.branchIntegration.cleanupSnapshot({ repoRoot: e.repoRoot, workerId: e.workerId }).catch(() => {});

      const shared = deps.workers.listAll().some(
        (w) => w.branch === e.branch && w.worktree_from === e.repoRoot,
      );
      if (shared) {
        deps.log.info("worktree kept — shared with another worker", { workerId: e.workerId, branch: e.branch });
      } else {
        const res = await deps.worktrees.remove({ repoRoot: e.repoRoot, worktreeDir: e.worktreeDir, branch: e.branch });
        deps.log.info("reaped worktree", { workerId: e.workerId, branch: e.branch, removed: res.removed, reason: res.reason });
      }
      deps.queue.delete(e.id);
    } catch (err) {
      // remove() never throws; a throw here (e.g. snapshot/listAll hiccup) keeps
      // the entry for the next tick rather than losing the cleanup.
      deps.log.warn("worktree reap failed — will retry", {
        workerId: e.workerId,
        branch: e.branch,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
