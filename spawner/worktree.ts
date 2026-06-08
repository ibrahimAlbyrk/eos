// Git worktree lifecycle. The realpath dance is critical: macOS /tmp is a
// symlink to /private/tmp, and Claude writes transcripts under a directory
// derived from the cwd's realpath. Without canonical paths everywhere, the
// JSONL tail watches the wrong directory and never fires.

import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { hydrateWorktree, type HydrationItem } from "./hydrate.ts";

export interface WorktreeContext {
  repoRoot: string | null;
  worktreeDir: string | null;
  branch: string | null;
  cwd: string;
  hydration: HydrationItem[] | null;
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
  hydrateEnv: boolean;
}

/**
 * Resolves the worker's working directory. Either creates a fresh git
 * worktree on a new branch (when `worktreeFrom` is given) or uses the
 * provided cwd directly. Path canonicalization happens here so downstream
 * code always sees a realpath'd absolute directory.
 */
export function setupWorktree(spec: WorktreeSpec, log: (m: string) => void): WorktreeContext {
  if (spec.worktreeFrom) {
    const repoRoot = realpathSync(resolve(spec.worktreeFrom));
    const head = git(["rev-parse", "--git-dir"], repoRoot);
    if (head.code !== 0) {
      console.error(`[${spec.name}] not a git repo: ${repoRoot}`);
      process.exit(1);
    }
    const branch = spec.branch ?? `eos-${spec.name}-${Date.now().toString(36)}`;
    const wtBase = join(repoRoot, ".eos", "worktrees");
    mkdirSync(wtBase, { recursive: true });
    const wtPath = join(wtBase, branch);
    const add = git(["worktree", "add", wtPath, "-b", branch], repoRoot);
    if (add.code !== 0) {
      console.error(`[${spec.name}] worktree add failed: ${add.stderr.trim()}`);
      process.exit(1);
    }
    const worktreeDir = realpathSync(wtPath);
    log(`worktree created: ${worktreeDir} on branch ${branch}`);
    const hydration = hydrateWorktree({
      repoRoot,
      worktreeDir,
      includeEnvFiles: spec.hydrateEnv,
      log,
    });
    return { repoRoot, worktreeDir, branch, cwd: worktreeDir, hydration };
  }
  const cwd = realpathSync(resolve(spec.cwd!));
  mkdirSync(cwd, { recursive: true });
  return { repoRoot: null, worktreeDir: null, branch: null, cwd, hydration: null };
}

/**
 * On shutdown, summarize worktree changes to the worker's stdout and either
 * remove the worktree (when clean + not pinned) or preserve it for review.
 * Emits a `worktree` lifecycle event so the daemon can show the outcome in
 * the UI.
 */
export interface TeardownInput {
  ctx: WorktreeContext;
  name: string;
  keep: boolean;
  emit(type: string, payload: unknown): void;
}

export function teardownWorktree({ ctx, name, keep, emit }: TeardownInput): void {
  const { repoRoot, worktreeDir, branch } = ctx;
  if (!repoRoot || !worktreeDir || !branch) return;
  const status = git(["status", "--short"], worktreeDir);
  const diffStat = git(["diff", "--stat"], worktreeDir);
  const hasChanges = status.stdout.trim().length > 0;
  console.log(`\n[${name}] worktree summary:`);
  console.log(`  path:    ${worktreeDir}`);
  console.log(`  branch:  ${branch}`);
  console.log(`  status:`);
  (status.stdout.trim() || "(clean)").split("\n").forEach((l) => console.log(`    ${l}`));
  if (diffStat.stdout.trim()) {
    console.log(`  diff stat:`);
    diffStat.stdout.trim().split("\n").forEach((l) => console.log(`    ${l}`));
  }
  if (!hasChanges && !keep) {
    console.log(`  no changes — removing worktree`);
    const removeResult = git(["worktree", "remove", worktreeDir, "--force"], repoRoot);
    if (removeResult.code !== 0) {
      console.error(`[${name}] worktree remove failed: ${removeResult.stderr}`);
      emit("worktree", { phase: "error", path: worktreeDir, branch, error: removeResult.stderr });
      return;
    }
    const branchResult = git(["branch", "-D", branch], repoRoot);
    if (branchResult.code !== 0) {
      console.error(`[${name}] branch delete failed: ${branchResult.stderr}`);
    }
    emit("worktree", { phase: "cleaned", path: worktreeDir, branch });
  } else if (keep || hasChanges) {
    console.log(`  (worktree preserved for review; run: git -C ${repoRoot} worktree remove ${worktreeDir})`);
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
