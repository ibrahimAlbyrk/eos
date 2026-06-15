// WorktreeRemovalQueue — durable record of worktrees scheduled for removal.
// KillWorker enqueues an entry (synchronously, before the worker row is
// deleted) so a daemon crash/SIGKILL can't strand the tree; ReapWorktreeRemovals
// drains it on boot + on an interval. Deliberately tiny (ISP): the reaper owns
// the shared-workspace + git-removal decisions, not this store.

export interface WorktreeRemovalEntry {
  /** = worker id. A worker is deleted once, so the id is a natural PK and a
   *  re-enqueue is an idempotent replace. */
  id: string;
  workerId: string;
  repoRoot: string;
  worktreeDir: string | null;
  branch: string;
  /** Earliest time the reaper may act — now + kill grace, so the PTY child's
   *  cwd is freed first. The reaper skips entries whose grace hasn't elapsed. */
  scheduledAt: number;
}

export interface WorktreeRemovalQueue {
  /** Idempotent on id (INSERT OR REPLACE). */
  enqueue(entry: WorktreeRemovalEntry): void;
  list(): WorktreeRemovalEntry[];
  delete(id: string): void;
}
