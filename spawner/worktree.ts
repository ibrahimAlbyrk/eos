// Git worktree lifecycle. The realpath dance is critical: macOS /tmp is a
// symlink to /private/tmp, and Claude writes transcripts under a directory
// derived from the cwd's realpath. Without canonical paths everywhere, the
// JSONL tail watches the wrong directory and never fires.

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hydrateWorktree, type HydrationItem } from "../infra/src/git/hydrateWorktree.ts";

export interface WorktreeContext {
  repoRoot: string | null;
  worktreeDir: string | null;
  branch: string | null;
  forkBaseSha: string | null;
  cwd: string;
  hydration: HydrationItem[] | null;
  // Attach mode: this worker joined another worker's worktree (workspaceOf).
  // It never creates, hydrates, or summarizes the shared tree.
  attached: boolean;
}

function git(args: string[], cwd?: string, env?: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: env ? { ...process.env, ...env } : undefined });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * Capture the source checkout's uncommitted work (modified + staged +
 * untracked, gitignore-respecting) as a commit object WITHOUT touching the
 * repo's real index or working tree — a temp GIT_INDEX_FILE absorbs every
 * staging side effect. The worktree is then forked from this commit, so it
 * carries the work-in-progress content while still booting clean (the changes
 * are the fork base, not uncommitted edits). Returns null when the tree is
 * clean or any step fails, so the caller falls back to a plain HEAD fork.
 * Mirrors the proven idiom in ChildProcessBranchIntegration.snapshot — kept
 * separate because that one is async/execFile in infra while the spawner shells
 * out synchronously and never depends on infra.
 */
function snapshotDirtyState(repoRoot: string): string | null {
  if (!git(["status", "--porcelain"], repoRoot).stdout.trim()) return null;
  const tmpIndex = join(tmpdir(), `eos-carry-${process.pid}-${Date.now().toString(36)}`);
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };
  try {
    if (git(["read-tree", "HEAD"], repoRoot, idxEnv).code !== 0) return null;
    if (git(["add", "-A"], repoRoot, idxEnv).code !== 0) return null;
    const tree = git(["write-tree"], repoRoot, idxEnv).stdout.trim();
    const head = git(["rev-parse", "HEAD"], repoRoot).stdout.trim();
    if (!tree || !head) return null;
    // Fixed identity so commit-tree never fails on a repo with no user.name set.
    const commit = git(
      ["commit-tree", tree, "-p", head, "-m", "eos: carry uncommitted changes"],
      repoRoot,
      { GIT_AUTHOR_NAME: "eos", GIT_AUTHOR_EMAIL: "eos@local", GIT_COMMITTER_NAME: "eos", GIT_COMMITTER_EMAIL: "eos@local" },
    );
    return commit.code === 0 ? commit.stdout.trim() || null : null;
  } finally {
    try { unlinkSync(tmpIndex); } catch {}
  }
}

export interface WorktreeSpec {
  worktreeFrom: string | undefined;
  cwd: string | undefined;
  name: string;
  branch: string | undefined;
  // Daemon-precomputed target dir (create mode) or the existing dir to join
  // (attach mode). Absent → legacy derivation from repoRoot + branch.
  worktreeDir: string | undefined;
  attach: boolean;
  hydrateEnv: boolean;
  // Fork the new worktree from a snapshot of the source's uncommitted work
  // (settings: git.carryUncommitted) instead of a clean HEAD checkout.
  carryUncommitted: boolean;
}

/**
 * Resolves the worker's working directory. Creates a fresh git worktree on a
 * new branch (when `worktreeFrom` is given), joins an existing one (attach
 * mode), or uses the provided cwd directly. Path canonicalization happens
 * here so downstream code always sees a realpath'd absolute directory.
 * Async only for the shared hydrateWorktree (execFile-based); the git calls
 * here stay sync — this runs in the worker child, not the daemon.
 */
export async function setupWorktree(spec: WorktreeSpec, log: (m: string) => void): Promise<WorktreeContext> {
  if (spec.attach && spec.worktreeDir && spec.worktreeFrom) {
    // Attach mode: the worktree belongs to another live worker — verify and
    // join it. No create, no hydration (the owner already hydrated), and no
    // fork stamp (the row-less mergeBase fallback covers the diff view).
    const repoRoot = realpathSync(resolve(spec.worktreeFrom));
    let worktreeDir: string;
    try {
      worktreeDir = realpathSync(resolve(spec.worktreeDir));
    } catch {
      console.error(`[${spec.name}] worktree to attach to not found: ${spec.worktreeDir}`);
      process.exit(1);
    }
    const head = git(["rev-parse", "--git-dir"], worktreeDir);
    if (head.code !== 0) {
      console.error(`[${spec.name}] not a git worktree: ${worktreeDir}`);
      process.exit(1);
    }
    log(`attached to worktree: ${worktreeDir} on branch ${spec.branch ?? "?"}`);
    return { repoRoot, worktreeDir, branch: spec.branch ?? null, forkBaseSha: null, cwd: worktreeDir, hydration: null, attached: true };
  }
  if (spec.worktreeFrom) {
    const repoRoot = realpathSync(resolve(spec.worktreeFrom));
    const head = git(["rev-parse", "--git-dir"], repoRoot);
    if (head.code !== 0) {
      console.error(`[${spec.name}] not a git repo: ${repoRoot}`);
      process.exit(1);
    }
    const branch = spec.branch ?? `eos-${spec.name}-${Date.now().toString(36)}`;
    // The daemon precomputes the target dir (same derivation) so the DB row is
    // complete at insert; honor it verbatim when present.
    const wtPath = spec.worktreeDir ?? join(repoRoot, ".eos", "worktrees", branch);
    mkdirSync(dirname(wtPath), { recursive: true });
    // Carry the source's uncommitted work into the worktree by forking from a
    // snapshot commit of its dirty state. A clean source (or snapshot failure)
    // yields null → plain HEAD fork, byte-identical to the prior behavior.
    const startPoint = spec.carryUncommitted ? snapshotDirtyState(repoRoot) : null;
    const add = git(["worktree", "add", wtPath, "-b", branch, ...(startPoint ? [startPoint] : [])], repoRoot);
    if (add.code !== 0) {
      console.error(`[${spec.name}] worktree add failed: ${add.stderr.trim()}`);
      process.exit(1);
    }
    if (startPoint) log(`carried uncommitted changes into worktree (base ${startPoint.slice(0, 8)})`);
    const worktreeDir = realpathSync(wtPath);
    // Stamp the fork commit now — the stable diff base for this worktree's
    // lifetime. Re-deriving it later via merge-base against the source
    // checkout's moving HEAD makes a clean worktree look dirty when the user
    // rewinds to a commit older than the fork point.
    const forkBaseSha = git(["rev-parse", "HEAD"], worktreeDir).stdout.trim() || null;
    log(`worktree created: ${worktreeDir} on branch ${branch}`);
    const hydration = await hydrateWorktree({
      repoRoot,
      worktreeDir,
      includeEnvFiles: spec.hydrateEnv,
      log,
    });
    return { repoRoot, worktreeDir, branch, forkBaseSha, cwd: worktreeDir, hydration, attached: false };
  }
  const cwd = realpathSync(resolve(spec.cwd!));
  mkdirSync(cwd, { recursive: true });
  return { repoRoot: null, worktreeDir: null, branch: null, forkBaseSha: null, cwd, hydration: null, attached: false };
}

/**
 * On shutdown, summarize worktree changes to the worker's stdout and emit a
 * `worktree` lifecycle event so the daemon can show the outcome in the UI.
 * Removal is daemon-owned (delete route enqueues a durable removal that a
 * reaper drains; startup prune is a secondary net) — removing a clean worktree
 * here would race agents attached to the same workspace and break resuming this
 * worker into its intact workspace. Attached workers skip the summary entirely:
 * the workspace is the owner's to report on.
 */
export interface TeardownInput {
  ctx: WorktreeContext;
  name: string;
  emit(type: string, payload: unknown): void;
}

export function teardownWorktree({ ctx, name, emit }: TeardownInput): void {
  const { repoRoot, worktreeDir, branch, attached } = ctx;
  if (!repoRoot || !worktreeDir || !branch || attached) return;
  const status = git(["status", "--short"], worktreeDir);
  const diffStat = git(["diff", "--stat"], worktreeDir);
  console.log(`\n[${name}] worktree summary:`);
  console.log(`  path:    ${worktreeDir}`);
  console.log(`  branch:  ${branch}`);
  console.log(`  status:`);
  (status.stdout.trim() || "(clean)").split("\n").forEach((l) => console.log(`    ${l}`));
  if (diffStat.stdout.trim()) {
    console.log(`  diff stat:`);
    diffStat.stdout.trim().split("\n").forEach((l) => console.log(`    ${l}`));
  }
  console.log(`  (worktree preserved; the daemon removes it when the worker is deleted)`);
  // The UI banner ("worktree preserved") only matters when uncommitted work
  // is at stake — a clean tree exits silently, as before.
  if (status.stdout.trim().length > 0) {
    emit("worktree", { phase: "preserved", path: worktreeDir, branch, status: status.stdout, diffStat: diffStat.stdout });
  }
}

// encodeCwd moved to core (single source of truth for Claude's project-dir
// encoding — now shared with the memory feature). Re-exported here so the
// existing transcript-path call sites (tail.ts, subagent-meta.ts) keep their
// import. The three earlier realpathSync sites enforce that its input is
// canonical before encoding.
export { encodeCwd } from "../core/src/domain/claude-paths.ts";
