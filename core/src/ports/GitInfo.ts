// GitInfo — read-only port for inspecting a git working directory. Adapter
// shells out to the `git` binary; we keep the interface narrow so any future
// libgit2 implementation can plug in without disturbing callers.

import type { ChangedFile, CommitDetail, FileDiffResponse, UnpushedCommit } from "../../../contracts/src/http.ts";
import type { PushState } from "../domain/push-plan.ts";
import type { PullState } from "../domain/pull-plan.ts";

export interface DiffStat {
  insertions: number;
  deletions: number;
  files: number;
}

export interface SyncStatus {
  ahead: number;
  behind: number;
}

// One unmerged file in the working tree. `xy` is the raw porcelain code
// (UU/AA/DU/UD/AU/UA/DD) — the use-case classifies it into a semantic kind.
export interface ConflictEntry {
  path: string;
  xy: string;
}

export interface GitInfo {
  /** True when cwd is inside a git working tree — including a freshly-init'd
   *  repo with no commits yet (unborn HEAD), where branch listing and HEAD
   *  resolution both come back empty. Never derive repo-ness from those. */
  isRepo(cwd: string): Promise<boolean>;
  listBranches(cwd: string): Promise<string[]>;
  /** Remote-tracking branches as full refs (e.g. "origin/main"); the symbolic
   *  "<remote>/HEAD" pointer is excluded. Empty on error / no remotes. */
  remoteBranches(cwd: string): Promise<string[]>;
  /** Configured remote names (e.g. ["origin"]). Empty on error / no remotes. */
  remotes(cwd: string): Promise<string[]>;
  currentBranch(cwd: string): Promise<string | null>;
  /** With `base`, diffs base..working-tree (committed-after-fork + uncommitted);
   *  without, HEAD..working-tree (uncommitted only). */
  diffShortStat(cwd: string, base?: string): Promise<DiffStat>;
  checkout(cwd: string, branch: string): Promise<void>;
  /** `git stash push` — set aside tracked working-tree changes so a blocked
   *  checkout can proceed. Resolves even when there's nothing to stash. */
  stashPush(cwd: string): Promise<void>;
  remoteUrl(cwd: string): Promise<string | null>;
  syncStatus(cwd: string): Promise<SyncStatus | null>;
  stashCount(cwd: string): Promise<number>;
  conflictCount(cwd: string): Promise<number>;
  /** Unmerged files in the working tree (porcelain XY in the unmerged set).
   *  Empty when the tree has no conflicts. conflictCount === conflictList.length
   *  by construction (both gate on the same unmerged-code set). */
  conflictList(cwd: string): Promise<ConflictEntry[]>;
  /** Working-tree content of a conflicted file, WITH the `<<<<<<< === >>>>>>>`
   *  markers git wrote. Empty string when unreadable. */
  conflictFileContent(cwd: string, path: string): Promise<string>;
  /** One merge stage of a path via `git show :N:path` (1=base, 2=ours,
   *  3=theirs). Null when that stage is absent (a side deleted/never had it). */
  stageContent(cwd: string, path: string, stage: 1 | 2 | 3): Promise<string | null>;
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
  /** Branch + upstream presence + ahead/behind — the input to the pure pull
   *  decision (decidePullPlan). Collapses to a benign null/zero state on error. */
  pullState(cwd: string): Promise<PullState>;
  /** True when the working tree has uncommitted changes (`git status --porcelain`
   *  non-empty). Working-tree-only — unlike diffShortStat(base) it never counts
   *  committed-after-fork work, so it's a correct "commit before pushing" gate. */
  hasUncommittedChanges(cwd: string): Promise<boolean>;
}
