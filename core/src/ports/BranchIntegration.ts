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
        | "active-try" // this worker already has an active layer
        | "conflicts" // vs the user's HEAD
        | "conflicts-with-try" // clean vs HEAD, conflicts vs an active layer (detail = its workerId)
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
  /** Apply the merged result as unstaged edits on top of the current stack. */
  apply(ref: TryRef): Promise<TryApplyResult>;
  /** Reverse-apply the recorded patch of this worker's layer. Refuses when the
   *  user edited a touched file mid-try, or when a layer above overlaps —
   *  nothing is reverted in either case. */
  discard(repoRoot: string, workerId: string): Promise<TryDiscardResult>;
  /** Drop this worker's layer; its edits become the user's own working-tree
   *  changes. Tree-neutral, so valid for any layer in any order. Records a
   *  per-worker kept marker so the UI never re-offers Apply for work the user
   *  already integrated. */
  keep(repoRoot: string, workerId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Active layers, bottom (oldest) first. */
  activeTries(repoRoot: string): Promise<ActiveTry[]>;
  /** True once this worker's try was kept (survives restarts; discard never
   *  sets it). */
  wasKept(input: { repoRoot: string; workerId: string }): Promise<boolean>;
  /** Delete the worker's snapshot ref (kill cleanup). Never touches an active
   *  try's patch/state — discard must survive worker deletion. */
  cleanupSnapshot(input: { repoRoot: string; workerId: string }): Promise<void>;
}
