// ChildProcessWorktreeManager — write-capable git worktree adapter. Shells out
// to the `git` binary via execFile (async, so the daemon event loop is never
// blocked on a slow `git worktree remove`). Force-removes regardless of
// uncommitted changes; failures collapse to a benign result so a kill/prune is
// never aborted by a git hiccup.
//
// realpath note: the daemon stores worktree_from via expandPath (only `~`
// expansion, NOT realpath), while git tracks realpath'd paths (and macOS /tmp
// is a symlink to /private/tmp). So every git call realpaths repoRoot first, or
// the derived `.eos/worktrees/<branch>` path won't match what git knows.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpathSync, existsSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import type { WorktreeManager, WorktreeRef, WorktreeEntry } from "../../../core/src/ports/WorktreeManager.ts";

const exec = promisify(execFile);

interface GitResult { code: number; stdout: string; stderr: string }

async function git(repoRoot: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await exec("git", ["-C", repoRoot, ...args], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof err.code === "number" ? err.code : -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function realpathOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

const MANAGED_SEGMENT = `${sep}.eos${sep}worktrees${sep}`;

export const childProcessWorktreeManager: WorktreeManager = {
  async remove(ref: WorktreeRef): Promise<{ removed: boolean; reason?: string }> {
    if (!ref.branch) return { removed: false, reason: "no branch" };
    const root = realpathOr(ref.repoRoot);
    const dir = ref.worktreeDir ?? join(root, ".eos", "worktrees", ref.branch);

    // Safety: never operate on the repo's main worktree.
    if (realpathOr(dir) === root) return { removed: false, reason: "refusing repo root" };

    // 1. Force-remove the worktree (overrides dirty/untracked changes).
    await git(root, ["worktree", "remove", dir, "--force"]);
    // 2. Reconcile stale admin entries left by a half-removed / racing teardown.
    await git(root, ["worktree", "prune"]);
    // 3. fs safety-net: guarantee the dir is gone, but only ever under the
    //    managed .eos/worktrees/ tree so we can't touch anything else.
    if (existsSync(dir) && dir.includes(MANAGED_SEGMENT)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      await git(root, ["worktree", "prune"]);
    }
    // 4. Tombstone, then delete the branch (already-gone is success). When the
    //    branch holds commits unreachable from HEAD, an eos/trash tag keeps
    //    them recoverable — bytes-cheap in the shared object store.
    const unmerged = await git(root, ["rev-list", "--count", ref.branch, "--not", "HEAD"]);
    if (unmerged.code === 0 && (Number.parseInt(unmerged.stdout.trim(), 10) || 0) > 0) {
      await git(root, ["tag", `eos/trash/${ref.branch}-${Date.now().toString(36)}`, ref.branch]);
    }
    await git(root, ["branch", "-D", ref.branch]);
    return { removed: true };
  },

  async listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
    const root = realpathOr(repoRoot);
    const r = await git(root, ["worktree", "list", "--porcelain"]);
    if (r.code !== 0) return [];
    const entries: WorktreeEntry[] = [];
    let cur: Partial<WorktreeEntry> | null = null;
    let first = true;
    const flush = (): void => {
      if (cur && typeof cur.path === "string") {
        entries.push({
          path: cur.path,
          branch: cur.branch ?? null,
          locked: cur.locked ?? false,
          isMain: cur.isMain ?? false,
        });
      }
      cur = null;
    };
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) {
        flush();
        cur = { path: line.slice("worktree ".length).trim(), isMain: first };
        first = false;
      } else if (cur && line.startsWith("branch ")) {
        cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      } else if (cur && (line === "locked" || line.startsWith("locked "))) {
        cur.locked = true;
      } else if (cur && line === "bare") {
        cur.isMain = true;
      }
    }
    flush();
    return entries;
  },
};
