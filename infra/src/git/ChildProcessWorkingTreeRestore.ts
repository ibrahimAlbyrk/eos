// ChildProcessWorkingTreeRestore — discards working-tree changes via the `git`
// binary, always with `-C <cwd>`. Mirrors ChildProcessBranchAdmin: never throws,
// a non-zero git exit comes back as { ok:false, error } the route maps to HTTP.
// Args are passed as an array (no shell) so paths can't inject.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkingTreeRestore, RestoreResult } from "../../../core/src/ports/WorkingTreeRestore.ts";

const exec = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<RestoreResult> {
  try {
    await exec("git", ["-C", cwd, ...args], { maxBuffer: 4 * 1024 * 1024 });
    return { ok: true };
  } catch (e) {
    const err = e as { stderr?: string };
    const stderr = err.stderr ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, error: stderr.trim().split("\n").filter(Boolean)[0] ?? "git command failed" };
  }
}

export const childProcessWorkingTreeRestore: WorkingTreeRestore = {
  restoreToBase(cwd: string, paths: string[], base?: string): Promise<RestoreResult> {
    if (paths.length === 0) return Promise.resolve({ ok: true });
    return runGit(cwd, ["restore", "--source", base ?? "HEAD", "--staged", "--worktree", "--", ...paths]);
  },
  removeUntracked(cwd: string, paths: string[]): Promise<RestoreResult> {
    if (paths.length === 0) return Promise.resolve({ ok: true });
    return runGit(cwd, ["clean", "-f", "--", ...paths]);
  },
};
