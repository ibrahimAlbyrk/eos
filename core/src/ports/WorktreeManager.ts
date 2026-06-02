// WorktreeManager — write-capable git worktree port (force-remove + enumerate).
// Deliberately separate from the read-only GitInfo port so GitInfo's read-only
// contract stays intact. The adapter shells out to `git` in infra/.

export interface WorktreeRef {
  /** Source repo root (may be a non-canonical path; the adapter realpaths it). */
  repoRoot: string;
  /** Resolved worktree dir, or null to let the adapter derive it from branch. */
  worktreeDir: string | null;
  branch: string;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  locked: boolean;
  isMain: boolean;
}

export interface WorktreeManager {
  /** Force-remove the worktree dir + delete its branch, regardless of
   *  uncommitted changes. Idempotent: an already-gone worktree/branch still
   *  resolves to removed:true. Never throws. */
  remove(ref: WorktreeRef): Promise<{ removed: boolean; reason?: string }>;
  /** Enumerate git-tracked worktrees for a repo via `worktree list --porcelain`. */
  listWorktrees(repoRoot: string): Promise<WorktreeEntry[]>;
}
