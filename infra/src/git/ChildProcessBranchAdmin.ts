// ChildProcessBranchAdmin — local branch ref management via the `git` binary.
// Always runs with `-C <cwd>`. Never throws: a non-zero git exit comes back as
// a classified result the route maps to HTTP. Uses `checkout -b` (not the newer
// `switch -c`) to match the existing checkout path and stay compatible.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BranchAdmin, BranchOpResult, BranchDeleteResult } from "../../../core/src/ports/BranchAdmin.ts";

const exec = promisify(execFile);

interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitRun> {
  try {
    const { stdout, stderr } = await exec("git", ["-C", cwd, ...args], { maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const stderr = err.stderr ?? (e instanceof Error ? e.message : String(e));
    return { ok: false, stdout: err.stdout ?? "", stderr };
  }
}

function firstLine(stderr: string): string {
  return stderr.trim().split("\n").filter(Boolean)[0] ?? "git command failed";
}

export const childProcessBranchAdmin: BranchAdmin = {
  async create(cwd: string, name: string, startPoint: string | null, opts: { checkout: boolean }): Promise<BranchOpResult> {
    const args = opts.checkout
      ? ["checkout", "-b", name, ...(startPoint ? [startPoint] : [])]
      : ["branch", name, ...(startPoint ? [startPoint] : [])];
    const r = await runGit(cwd, args);
    return r.ok ? { ok: true, branch: name } : { ok: false, error: firstLine(r.stderr) };
  },

  async rename(cwd: string, from: string, to: string): Promise<BranchOpResult> {
    const r = await runGit(cwd, ["branch", "-m", from, to]);
    return r.ok ? { ok: true, branch: to } : { ok: false, error: firstLine(r.stderr) };
  },

  async remove(cwd: string, name: string, opts: { force: boolean }): Promise<BranchDeleteResult> {
    const r = await runGit(cwd, ["branch", opts.force ? "-D" : "-d", name]);
    if (r.ok) return { ok: true, deleted: true };
    // `-d` refuses a not-fully-merged branch — signal the UI to offer force.
    if (!opts.force && /not fully merged/i.test(r.stderr)) {
      return { ok: false, notMerged: true, error: firstLine(r.stderr) };
    }
    return { ok: false, error: firstLine(r.stderr) };
  },
};
