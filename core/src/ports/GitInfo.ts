// GitInfo — read-only port for inspecting a git working directory. Adapter
// shells out to the `git` binary; we keep the interface narrow so any future
// libgit2 implementation can plug in without disturbing callers.

import type { ChangedFile, FileDiffResponse, UnpushedCommit } from "../../../contracts/src/http.ts";

export interface DiffStat {
  insertions: number;
  deletions: number;
  files: number;
}

export interface SyncStatus {
  ahead: number;
  behind: number;
}

export interface GitInfo {
  listBranches(cwd: string): Promise<string[]>;
  currentBranch(cwd: string): Promise<string | null>;
  /** With `base`, diffs base..working-tree (committed-after-fork + uncommitted);
   *  without, HEAD..working-tree (uncommitted only). */
  diffShortStat(cwd: string, base?: string): Promise<DiffStat>;
  checkout(cwd: string, branch: string): Promise<void>;
  remoteUrl(cwd: string): Promise<string | null>;
  syncStatus(cwd: string): Promise<SyncStatus | null>;
  stashCount(cwd: string): Promise<number>;
  conflictCount(cwd: string): Promise<number>;
  changedFiles(cwd: string, base?: string): Promise<ChangedFile[]>;
  fileDiff(cwd: string, path: string, oldPath?: string, base?: string): Promise<FileDiffResponse>;
  /** Commits the upstream doesn't have (@{u}..HEAD), newest first. Empty when
   *  there's no upstream. */
  unpushedCommits(cwd: string): Promise<UnpushedCommit[]>;
  /** Fork point: merge-base of cwd's HEAD and otherRepoRoot's HEAD (shared
   *  object store assumed — a worktree vs its source checkout). Null when
   *  either side can't resolve. */
  mergeBase(cwd: string, otherRepoRoot: string): Promise<string | null>;
}
