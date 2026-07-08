// GitInfo — read-only port for inspecting a git working directory. Adapter
// shells out to the `git` binary; we keep the interface narrow so any future
// libgit2 implementation can plug in without disturbing callers.

import type { ChangedFile, CommitDetail, FileDiffResponse, FsStashEntry, UnpushedCommit } from "../../../contracts/src/http.ts";
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

// Result of a stash mutation (apply/drop). Never throws — a git failure
// (conflict on apply, bad index on drop) comes back as { ok:false, error }
// with git's stderr, which the route maps straight to the HTTP body.
export interface StashOpResult {
  ok: boolean;
  error?: string;
}

// One unmerged file in the working tree. `xy` is the raw porcelain code
// (UU/AA/DU/UD/AU/UA/DD) — the use-case classifies it into a semantic kind.
export interface ConflictEntry {
  path: string;
  xy: string;
}

// The git directories backing a working tree — what a watcher must observe.
// In a normal checkout gitDir === commonDir; in a linked worktree gitDir is the
// per-worktree dir (HEAD/index/merge state) while commonDir is the shared .git
// (refs/, packed-refs, stash). All absolute.
export interface GitDirs {
  toplevel: string;
  gitDir: string;
  commonDir: string;
}

export interface GitInfo {
  /** True when cwd is inside a git working tree — including a freshly-init'd
   *  repo with no commits yet (unborn HEAD), where branch listing and HEAD
   *  resolution both come back empty. Never derive repo-ness from those. */
  isRepo(cwd: string): Promise<boolean>;
  /** Resolve cwd's git directories (working-tree root + per-worktree git dir +
   *  shared common dir) so a watcher can observe the right paths. Null when cwd
   *  is not inside a work tree. */
  gitDirs(cwd: string): Promise<GitDirs | null>;
  listBranches(cwd: string): Promise<string[]>;
  /** Remote-tracking branches as full refs (e.g. "origin/main"); the symbolic
   *  "<remote>/HEAD" pointer is excluded. Empty on error / no remotes. */
  remoteBranches(cwd: string): Promise<string[]>;
  /** Configured remote names (e.g. ["origin"]). Empty on error / no remotes. */
  remotes(cwd: string): Promise<string[]>;
  currentBranch(cwd: string): Promise<string | null>;
  /** Local branch names ordered most-recently-checked-out first (de-duplicated),
   *  parsed from the HEAD reflog: each `checkout: moving from X to Y` contributes
   *  its target Y. Captures switches from anywhere — terminal, IDE, Eos — not just
   *  this app, and needs no persistent state. Empty on error or an empty reflog
   *  (e.g. a freshly-created worktree). Feeds the branch picker's recency order. */
  recentCheckouts(cwd: string): Promise<string[]>;
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
  /** Stash entries newest first (index 0 = most recent). branch parsed from
   *  the "WIP on <b>:" / "On <b>:" subject prefix, null when absent. Empty on
   *  error / no stashes. */
  stashList(cwd: string): Promise<FsStashEntry[]>;
  /** `git stash apply stash@{index}` — restore a stash's changes onto the
   *  working tree, leaving the entry in place. A conflict comes back as
   *  { ok:false, error } (git applied it with markers), never a throw. */
  stashApply(cwd: string, index: number): Promise<StashOpResult>;
  /** `git stash drop stash@{index}` — remove a stash entry. A bad index comes
   *  back as { ok:false, error }. */
  stashDrop(cwd: string, index: number): Promise<StashOpResult>;
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
  /** Paged HEAD history, newest first. Fetches limit+1 rows so callers can
   *  compute hasMore by comparing length against limit. Empty on error /
   *  unborn HEAD. */
  log(cwd: string, opts: { limit: number; skip: number }): Promise<UnpushedCommit[]>;
  /** Short sha a ref resolves to. Null when it doesn't resolve. */
  revParse(cwd: string, ref: string): Promise<string | null>;
  /** One commit's whole patch (`git show --patch`) — feeds the batched
   *  per-file patches of /fs/changes?sha&patches=1. Null when unavailable
   *  (huge patch overflowing the buffer, bad sha). */
  commitPatch(cwd: string, sha: string): Promise<string | null>;
  /** One file's diff within one commit — the ?sha= twin of fileDiff. */
  commitFileDiff(cwd: string, sha: string, path: string, oldPath?: string): Promise<FileDiffResponse>;
  /** Blob size in bytes at ref:path — the pre-flight cap check before
   *  blobAtRef. Null when the blob doesn't exist. */
  blobSizeAtRef(cwd: string, ref: string, path: string): Promise<number | null>;
  /** Raw blob bytes at ref:path (Uint8Array keeps core Node-free). Null when
   *  the blob doesn't exist or overflows the buffer. */
  blobAtRef(cwd: string, ref: string, path: string): Promise<Uint8Array | null>;
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
