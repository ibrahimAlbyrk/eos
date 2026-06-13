// ChildProcessRemoteSync — git operations against a remote (fetch / pull
// --ff-only / push --delete) via the `git` binary. Always runs with `-C <cwd>`.
// Never throws: failures come back classified, mirroring ChildProcessBranchPush.
// Pull is ALWAYS --ff-only; the diverged case never reaches here (the plan is
// non-actionable), so a non-zero exit means the remote moved or local edits
// block the fast-forward.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RemoteSync, FetchResult, PullExec, RemoteBranchDeleteResult } from "../../../core/src/ports/RemoteSync.ts";
import type { PullExecReason } from "../../../core/src/domain/pull-plan.ts";

const exec = promisify(execFile);

function firstLine(s: string): string {
  return s.trim().split("\n").filter(Boolean)[0] ?? "git command failed";
}

// Distinguish "local changes block the fast-forward" (commit/stash first) from
// "remote diverged since last fetch" (use the git agent to merge/rebase).
function classifyPull(stderr: string, stdout: string): PullExecReason {
  const s = (stderr + "\n" + stdout).toLowerCase();
  if (/would be overwritten|local changes|please commit|please, commit|stash/.test(s)) return "conflict";
  if (/not possible to fast-forward|have diverged|diverging|non-fast-forward|reconcile divergent/.test(s)) return "unrelated";
  return "failed";
}

export const childProcessRemoteSync: RemoteSync = {
  async fetch(cwd: string, opts: { remote?: string; prune: boolean }): Promise<FetchResult> {
    const args = ["fetch", ...(opts.prune ? ["--prune"] : []), ...(opts.remote ? [opts.remote] : ["--all"])];
    try {
      await exec("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, summary: opts.remote ? `Fetched ${opts.remote}` : "Fetched all remotes" };
    } catch (e) {
      const err = e as { stderr?: string };
      return { ok: false, error: firstLine(err.stderr ?? (e instanceof Error ? e.message : String(e))) };
    }
  },

  async pull(cwd: string): Promise<PullExec> {
    try {
      const { stdout, stderr } = await exec("git", ["-C", cwd, "pull", "--ff-only"], { maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, code: 0, stdout, stderr, reason: "pulled" };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      const code = typeof err.code === "number" ? err.code : 1;
      const stdout = err.stdout ?? "";
      const stderr = err.stderr ?? (e instanceof Error ? e.message : String(e));
      return { ok: false, code, stdout, stderr, reason: classifyPull(stderr, stdout) };
    }
  },

  async deleteRemoteBranch(cwd: string, remote: string, branch: string): Promise<RemoteBranchDeleteResult> {
    try {
      await exec("git", ["-C", cwd, "push", remote, "--delete", branch], { maxBuffer: 4 * 1024 * 1024 });
      return { ok: true };
    } catch (e) {
      const err = e as { stderr?: string };
      return { ok: false, error: firstLine(err.stderr ?? (e instanceof Error ? e.message : String(e))) };
    }
  },
};
