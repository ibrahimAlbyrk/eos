// BranchIntegration — unstaged Try. Applies a worker branch's merged result
// into the user's checkout as working-tree-only edits (no index writes, no
// MERGE_HEAD, no pending git state), with hash-verified discard. Deliberately
// separate from WorktreeManager: that port owns worktree lifecycle, this one
// owns checkout integration. The adapter shells out to `git` in infra/.
//
// Mechanics (adapter): temp-index snapshot of the worktree pinned at
// refs/eos/snapshots/<workerId> → `git merge-tree --write-tree` conflict
// prediction (ref-only) → patch = `git diff --binary HEAD <mergedTree>` →
// `git apply` (verify-all-then-write). Patch + state persist outside the
// worktree so an active try survives daemon restarts and worker deletion.

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
  activeTry: ActiveTry | null;
}

export type TryApplyResult =
  | { ok: true; files: string[]; lockfileChanged: boolean }
  | {
      ok: false;
      reason: "active-try" | "conflicts" | "dirty-files" | "nothing-to-apply" | "unsupported" | "git-error";
      files?: string[];
      detail?: string;
    };

export type TryDiscardResult =
  | { ok: true }
  | { ok: false; reason: "no-active-try" | "user-edited" | "git-error"; files?: string[]; detail?: string };

export interface BranchIntegration {
  preview(ref: TryRef): Promise<TryPreview>;
  /** Apply the merged result as unstaged edits. One active try per repo. */
  apply(ref: TryRef): Promise<TryApplyResult>;
  /** Reverse-apply the recorded patch. Refuses per-file when the user edited
   *  a touched file mid-try — nothing is reverted in that case. */
  discard(repoRoot: string): Promise<TryDiscardResult>;
  /** Drop the try state; the edits become the user's own working-tree changes.
   *  Records a per-worker kept marker so the UI never re-offers Apply for
   *  work the user already integrated. */
  keep(repoRoot: string): Promise<{ ok: boolean; reason?: string }>;
  activeTry(repoRoot: string): Promise<ActiveTry | null>;
  /** True once this worker's try was kept (survives restarts; discard never
   *  sets it). */
  wasKept(input: { repoRoot: string; workerId: string }): Promise<boolean>;
  /** Delete the worker's snapshot ref (kill cleanup). Never touches an active
   *  try's patch/state — discard must survive worker deletion. */
  cleanupSnapshot(input: { repoRoot: string; workerId: string }): Promise<void>;
}
