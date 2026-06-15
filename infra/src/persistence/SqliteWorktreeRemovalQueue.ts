// SqliteWorktreeRemovalQueue — SQLite-backed WorktreeRemovalQueue. Mirrors the
// other repos: prepared statements cached on the instance.

import type { DatabaseSync } from "node:sqlite";
import type { WorktreeRemovalQueue, WorktreeRemovalEntry } from "../../../core/src/ports/WorktreeRemovalQueue.ts";

type Row = Record<string, unknown>;

export class SqliteWorktreeRemovalQueue implements WorktreeRemovalQueue {
  private readonly stmtUpsert;
  private readonly stmtList;
  private readonly stmtDelete;

  constructor(db: DatabaseSync) {
    this.stmtUpsert = db.prepare(`
      INSERT INTO pending_worktree_removals (id, worker_id, repo_root, worktree_dir, branch, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        worker_id = excluded.worker_id,
        repo_root = excluded.repo_root,
        worktree_dir = excluded.worktree_dir,
        branch = excluded.branch,
        scheduled_at = excluded.scheduled_at
    `);
    this.stmtList = db.prepare("SELECT * FROM pending_worktree_removals ORDER BY scheduled_at ASC");
    this.stmtDelete = db.prepare("DELETE FROM pending_worktree_removals WHERE id = ?");
  }

  enqueue(entry: WorktreeRemovalEntry): void {
    this.stmtUpsert.run(
      entry.id,
      entry.workerId,
      entry.repoRoot,
      entry.worktreeDir,
      entry.branch,
      entry.scheduledAt,
    );
  }

  list(): WorktreeRemovalEntry[] {
    return (this.stmtList.all() as Row[]).map((r) => ({
      id: r.id as string,
      workerId: (r.worker_id as string | null) ?? "",
      repoRoot: r.repo_root as string,
      worktreeDir: (r.worktree_dir as string | null) ?? null,
      branch: r.branch as string,
      scheduledAt: r.scheduled_at as number,
    }));
  }

  delete(id: string): void {
    this.stmtDelete.run(id);
  }
}
