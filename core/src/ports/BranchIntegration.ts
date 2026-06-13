// BranchIntegration — unstaged Try. Applies a worker branch's merged result
// into the user's checkout as working-tree-only edits (no index writes, no
// MERGE_HEAD, no pending git state), with hash-verified discard. Deliberately
// separate from WorktreeManager: that port owns worktree lifecycle, this one
// owns checkout integration. The adapter shells out to `git` in infra/.
//
// Mechanics (adapter): temp-index snapshot of the worktree pinned at
// refs/eos/snapshots/<workerId> → `git merge-tree --write-tree` conflict
// prediction (ref-only) → patch = `git diff --binary <baseTree> <mergedTree>`
// → `git apply` (verify-all-then-write). Patch + state persist outside the
// worktree so active tries survive daemon restarts and worker deletion.
//
// Tries STACK: several workers' tries can be active in the same checkout at
// once, ordered by apply time. Each new layer merges against the virtual tree
// of HEAD + all layers below it. Keep never touches the tree, so any layer can
// be kept in any order; discard reverse-applies a patch, so a layer can only
// be discarded while no layer above it touches the same files.

export interface TryRef {
  /** User's source repo root (worktree_from; adapter realpaths it). */
  repoRoot: string;
  /** Worker's worktree dir, or null/gone — snapshot falls back to branch tip. */
  worktreeDir: string | null;
  branch: string;
  workerId: string;
}

export interface ActiveTry {
  workerId: string;
  branch: string;
  baseHead: string;
  files: string[];
  lockfileChanged: boolean;
  createdAt: number;
}

export interface TryPreview {
  /** false = git lacks merge-tree --write-tree (< 2.38) or snapshot failed. */
  supported: boolean;
  ahead: number;
  behind: number;
  conflicts: string[];
  files: string[];
  lockfileChanged: boolean;
  /** Bottom (oldest) first. */
  activeTries: ActiveTry[];
}

export type TryApplyResult =
  | { ok: true; files: string[]; lockfileChanged: boolean }
  | {
      ok: false;
      reason:
        | "conflicts" // vs the user's HEAD
        | "conflicts-with-try" // clean vs HEAD, conflicts vs an active layer (detail = its workerId)
        | "blocked-by-overlay" // a re-sync would corrupt a layer above (detail = its workerId)
        | "dirty-files"
        | "nothing-to-apply"
        | "unsupported"
        | "git-error";
      files?: string[];
      detail?: string;
    };

export type TryDiscardResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "no-active-try"
        | "user-edited"
        | "blocked-by-overlay" // a layer above touches the same files (detail = its workerId)
        | "git-error";
      files?: string[];
      detail?: string;
    };

export interface BranchIntegration {
  preview(ref: TryRef): Promise<TryPreview>;
  /** Idempotent: bring the checkout in step with the worktree's current state.
   *  First call applies the full merged result as unstaged edits; later calls
   *  re-sync, applying only the delta the worker produced since the last apply
   *  (so a bug-fix lands without re-touching everything). Works whether the
   *  worker's layer is still provisional or already kept. */
  apply(ref: TryRef): Promise<TryApplyResult>;
  /** Reverse-apply the recorded (cumulative) patch of this worker's layer.
   *  Refuses when the user edited a touched file mid-try, or when a layer above
   *  overlaps — nothing is reverted in either case. */
  discard(repoRoot: string, workerId: string): Promise<TryDiscardResult>;
  /** Accept this worker's layer: it drops out of the Keep/Discard deck but
   *  stays in the stack (its edits keep counting as the checkout's expected
   *  content) so the worktree can still be re-synced. Tree-neutral. */
  keep(repoRoot: string, workerId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Provisional layers only (the deck), bottom (oldest) first. */
  activeTries(repoRoot: string): Promise<ActiveTry[]>;
  /** True while this worker's layer is kept. */
  wasKept(input: { repoRoot: string; workerId: string }): Promise<boolean>;
  /** Whether the worktree advanced past what is currently applied/kept, plus
   *  the files a re-sync would change. Both empty/false when the worker has no
   *  layer yet (the UI offers a first Apply) or nothing is new. Side-effect
   *  free — safe to poll. */
  syncStatus(ref: TryRef): Promise<{ syncable: boolean; files: string[] }>;
  /** Kill cleanup. A provisional layer is preserved (its ref stays pinned) so
   *  discard survives worker deletion; a kept layer is finalized (dropped, its
   *  edits remain as the user's own changes); otherwise just deletes the ref. */
  cleanupSnapshot(input: { repoRoot: string; workerId: string }): Promise<void>;
}
