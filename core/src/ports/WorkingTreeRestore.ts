// WorkingTreeRestore — narrow write port for discarding working-tree changes by
// reverting files to a base tree. Kept separate from the read-only GitInfo and
// the other write ports (ISP): the decision of WHICH files and WHAT base is pure
// domain (DiscardFileChange); this port only runs the revert. Never throws —
// failures come back as a classified result the route maps to HTTP.

export interface RestoreResult {
  ok: boolean;
  error?: string;   // git stderr (trimmed) on failure
}

export interface WorkingTreeRestore {
  /** Reset the given paths (index + working tree) to `base` —
   *  `git restore --source=<base|HEAD> --staged --worktree`. Reverts
   *  modified/deleted/staged files; a path absent at base (a staged add, or a
   *  rename's new path) is removed. base undefined → HEAD. */
  restoreToBase(cwd: string, paths: string[], base?: string): Promise<RestoreResult>;
  /** Remove untracked paths — `git clean -f`. `git restore` can't touch a path
   *  git doesn't track, so untracked discards route here. */
  removeUntracked(cwd: string, paths: string[]): Promise<RestoreResult>;
}
