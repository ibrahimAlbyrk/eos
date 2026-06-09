// Git worktree lifecycle. The realpath dance is critical: macOS /tmp is a
// symlink to /private/tmp, and Claude writes transcripts under a directory
// derived from the cwd's realpath. Without canonical paths everywhere, the
// JSONL tail watches the wrong directory and never fires.

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hydrateWorktree, type HydrationItem } from "./hydrate.ts";

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

function git(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
}

/**
 * Resolves the worker's working directory. Creates a fresh git worktree on a
 * new branch (when `worktreeFrom` is given), joins an existing one (attach
 * mode), or uses the provided cwd directly. Path canonicalization happens
 * here so downstream code always sees a realpath'd absolute directory.
 */
export function setupWorktree(spec: WorktreeSpec, log: (m: string) => void): WorktreeContext {
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
    const add = git(["worktree", "add", wtPath, "-b", branch], repoRoot);
    if (add.code !== 0) {
      console.error(`[${spec.name}] worktree add failed: ${add.stderr.trim()}`);
      process.exit(1);
    }
    const worktreeDir = realpathSync(wtPath);
    // Stamp the fork commit now — the stable diff base for this worktree's
    // lifetime. Re-deriving it later via merge-base against the source
    // checkout's moving HEAD makes a clean worktree look dirty when the user
    // rewinds to a commit older than the fork point.
    const forkBaseSha = git(["rev-parse", "HEAD"], worktreeDir).stdout.trim() || null;
    log(`worktree created: ${worktreeDir} on branch ${branch}`);
    const hydration = hydrateWorktree({
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
 * Removal is daemon-owned (delete route + startup prune) — removing a clean
 * worktree here would race agents attached to the same workspace and break
 * resuming this worker into its intact workspace. Attached workers skip the
 * summary entirely: the workspace is the owner's to report on.
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

/**
 * Path encoding rule for Claude's transcript directory. Replace every char
 * not in [a-zA-Z0-9_-] with a single dash. Comment lives here because the
 * three earlier realpathSync sites collectively enforce the invariant that
 * encodeCwd's input is canonical.
 */
export function encodeCwd(p: string): string {
  return p.replace(/[^a-zA-Z0-9_-]/g, "-");
}
