// DiscardFileChange — reverts ONE changed file to the diff base, the inverse of
// what GET /changes shows: untracked files are removed (git clean), tracked
// files (modified/deleted/staged/renamed) are restored to base (git restore).
// Status is re-derived from changedFiles so a stale client can't mis-classify,
// and a path that's no longer changed is an idempotent no-op.

import type { GitInfo } from "../ports/GitInfo.ts";
import type { WorkingTreeRestore, RestoreResult } from "../ports/WorkingTreeRestore.ts";

export interface DiscardFileChangeDeps {
  git: Pick<GitInfo, "changedFiles">;
  restore: WorkingTreeRestore;
}

export interface DiscardFileChangeInput {
  cwd: string;
  path: string;
  base?: string;
}

export async function discardFileChange(
  deps: DiscardFileChangeDeps,
  input: DiscardFileChangeInput,
): Promise<RestoreResult> {
  const target = (await deps.git.changedFiles(input.cwd, input.base)).find((f) => f.path === input.path);
  if (!target) return { ok: true };
  if (target.untracked) return deps.restore.removeUntracked(input.cwd, [input.path]);
  // A rename's new path is restored together with its original: one restore
  // brings the old path back from base and removes the new one.
  const paths = target.status === "R" && target.oldPath ? [target.oldPath, input.path] : [input.path];
  return deps.restore.restoreToBase(input.cwd, paths, input.base);
}
