// WorktreeManager — write-capable git worktree port (force-remove + enumerate).
// Deliberately separate from the read-only GitInfo port so GitInfo's read-only
// contract stays intact. The adapter shells out to `git` in infra/.

export interface WorktreeRef {
  /** Source repo root (may be a non-canonical path; the adapter realpaths it). */
  repoRoot: string;
  /** Resolved worktree dir, or null to let the adapter derive it from branch. */
  worktreeDir: string | null;
  branch: string;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  locked: boolean;
  isMain: boolean;
}

export interface WorktreeCreateInput {
  /** Source repo root (the adapter realpaths it). */
  repoRoot: string;
  /** Branch to create the worktree on. */
  branch: string;
  /** Daemon-precomputed target dir; null → the adapter derives `.eos/worktrees/<branch>`. */
  worktreeDir: string | null;
  /** Fork from a snapshot of the source's uncommitted work instead of clean HEAD. */
  carryUncommitted?: boolean;
  /** Hydrate gitignored deps (node_modules always; .env files only when true) from
   *  the source checkout so the agent can build/test on turn one — parity with the
   *  claude-cli worker boot. */
  hydrateEnv?: boolean;
}

export interface WorktreeCreateResult {
  created: boolean;
  /** Realpath'd worktree dir (present when created). */
  worktreeDir?: string;
  /** The fork-base commit — the stable diff base for this worktree's lifetime. */
  forkBaseSha?: string | null;
  /** Why creation did not happen (non-repo, git error). */
  reason?: string;
}

export interface WorktreeManager {
  /** Materialize a fresh worktree on a new branch. The out-of-process claude-cli
   *  child creates its own during boot (spawner/worktree.ts); an IN-PROCESS backend
   *  (claude-sdk) has no such child, so the daemon creates it here before launch.
   *  Fails cleanly (created:false + reason) on a non-repo / git error, never throws. */
  create(input: WorktreeCreateInput): Promise<WorktreeCreateResult>;
  /** Force-remove the worktree dir + delete its branch, regardless of
   *  uncommitted changes. Idempotent: an already-gone worktree/branch still
   *  resolves to removed:true. Never throws. */
  remove(ref: WorktreeRef): Promise<{ removed: boolean; reason?: string }>;
  /** Enumerate git-tracked worktrees for a repo via `worktree list --porcelain`. */
  listWorktrees(repoRoot: string): Promise<WorktreeEntry[]>;
}
