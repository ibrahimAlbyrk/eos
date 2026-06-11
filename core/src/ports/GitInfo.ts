// GitInfo — read-only port for inspecting a git working directory. Adapter
// shells out to the `git` binary; we keep the interface narrow so any future
// libgit2 implementation can plug in without disturbing callers.

import type { ChangedFile, CommitDetail, FileDiffResponse, UnpushedCommit } from "../../../contracts/src/http.ts";
import type { PushState } from "../domain/push-plan.ts";

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
  /** One whole-tree unified diff (base/HEAD vs working tree) — feeds the
   *  batched per-file patches of /changes?patches=1. Null when unavailable
   *  (huge diff overflowing the buffer, no repo) — callers fall back to
   *  per-file diffs. */
  fullDiff(cwd: string, base?: string): Promise<string | null>;
  /** Commits the upstream doesn't have (@{u}..HEAD), newest first. Empty when
   *  there's no upstream. */
  unpushedCommits(cwd: string): Promise<UnpushedCommit[]>;
  /** Full detail of one commit (message body + per-file changes). Null when
   *  the sha doesn't resolve. */
  commitDetail(cwd: string, sha: string): Promise<CommitDetail | null>;
  /** Fork point: merge-base of cwd's HEAD and otherRepoRoot's HEAD (shared
   *  object store assumed — a worktree vs its source checkout). Null when
   *  either side can't resolve. */
  mergeBase(cwd: string, otherRepoRoot: string): Promise<string | null>;
  /** Branch + remote + upstream presence + ahead/behind, bundled — the input to
   *  the pure push decision. Collapses to a benign all-null/zero state on error. */
  pushState(cwd: string): Promise<PushState>;
  /** True when the working tree has uncommitted changes (`git status --porcelain`
   *  non-empty). Working-tree-only — unlike diffShortStat(base) it never counts
   *  committed-after-fork work, so it's a correct "commit before pushing" gate. */
  hasUncommittedChanges(cwd: string): Promise<boolean>;
}
