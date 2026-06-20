// BranchMerge — orchestrator fan-in. Merges several worker worktree branches
// into the orchestrator's own checkout in one pass. Deliberately separate from
// BranchIntegration: that port owns the reversible single-worker "Try" deck;
// this one owns a real multi-worker merge that leaves git's own conflict state
// (markers + unmerged index) for genuine overlaps, so the existing conflict
// resolver handles them. The adapter shells out to `git` in infra/.
//
// Mechanics (adapter): snapshot each worker's worktree (committed + uncommitted
// + untracked) into a commit, greedily stack-merge the clean snapshots via
// `git merge-tree --write-tree`, materialize the merged tree into the checkout
// working tree (patch HEAD → tree, no index writes for clean files), and for
// the first genuinely conflicting snapshot write its conflict-marked blobs plus
// synthesized stage 1/2/3 index entries (`git update-index --index-info`).
// Nothing is committed and no MERGE_HEAD is created — the result is reviewable
// working-tree state, undone with a plain reset.

export interface MergeWorkerRef {
  /** The checkout to merge INTO — the orchestrator's cwd, which equals every
   *  worker's worktree_from. The adapter realpaths it. */
  repoRoot: string;
  /** The worker's isolated worktree dir, or null/gone → fall back to its branch tip. */
  worktreeDir: string | null;
  branch: string;
  workerId: string;
}

export type MergeOutcome =
  | "merged" // snapshot merged cleanly into the checkout (unstaged edits)
  | "conflicted" // materialized with conflict markers + unmerged index
  | "pending" // not attempted — an earlier worker holds an unresolved conflict
  | "skipped"; // no snapshot / no changes to integrate

export interface MergeWorkerResult {
  workerId: string;
  branch: string;
  outcome: MergeOutcome;
  /** Files this worker contributed (merged) or that now bear markers (conflicted). */
  files: string[];
  reason?: string;
}

export interface MergeAllResult {
  ok: boolean;
  results: MergeWorkerResult[];
  /** Union of files brought in by all cleanly merged workers. */
  mergedFiles: string[];
  /** Files now holding conflict markers (a non-empty set means resolve-then-rerun). */
  conflictedFiles: string[];
  /** Adapter-level failure detail when ok is false and nothing could be merged. */
  detail?: string;
}

export interface BranchMerge {
  /** Merge each ref's worktree state into `checkout`. Refs are processed in the
   *  given order; conflicts past the first are returned `pending`. Never throws
   *  — git failures surface as skipped/pending outcomes or `ok:false`. */
  mergeAll(checkout: string, refs: MergeWorkerRef[]): Promise<MergeAllResult>;
}
