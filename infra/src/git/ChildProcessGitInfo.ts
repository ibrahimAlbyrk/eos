// ChildProcessGitInfo — shells out to the `git` binary via execFile. Always
// runs in the target directory with `-C <cwd>` so cwd can't be tricked.
// Failures (missing repo, missing git, etc.) collapse to empty/zero values
// so callers can render a benign "no info" state instead of throwing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitInfo, DiffStat } from "../../../core/src/ports/GitInfo.ts";

const exec = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function parseShortStat(line: string): DiffStat {
  // Examples: " 3 files changed, 12 insertions(+), 4 deletions(-)"
  //           " 1 file changed, 2 insertions(+)"
  //           ""                                  (no changes)
  const files = /(\d+) files? changed/.exec(line);
  const ins = /(\d+) insertions?\(\+\)/.exec(line);
  const del = /(\d+) deletions?\(-\)/.exec(line);
  return {
    files: files ? parseInt(files[1], 10) : 0,
    insertions: ins ? parseInt(ins[1], 10) : 0,
    deletions: del ? parseInt(del[1], 10) : 0,
  };
}

export const childProcessGitInfo: GitInfo = {
  async listBranches(cwd: string): Promise<string[]> {
    try {
      const out = await runGit(cwd, ["branch", "--format=%(refname:short)"]);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },

  async currentBranch(cwd: string): Promise<string | null> {
    try {
      const out = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const name = out.trim();
      return name && name !== "HEAD" ? name : null;
    } catch {
      return null;
    }
  },

  async checkout(cwd: string, branch: string): Promise<void> {
    await runGit(cwd, ["checkout", branch]);
  },

  async remoteUrl(cwd: string): Promise<string | null> {
    try {
      const out = await runGit(cwd, ["remote", "get-url", "origin"]);
      const raw = out.trim();
      if (!raw) return null;
      const ssh = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
      if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
      return raw.replace(/\.git$/, "");
    } catch {
      return null;
    }
  },

  async diffShortStat(cwd: string): Promise<DiffStat> {
    try {
      // HEAD includes both staged and unstaged changes vs. the last commit.
      const out = await runGit(cwd, ["diff", "--shortstat", "HEAD"]);
      return parseShortStat(out.trim());
    } catch {
      return { files: 0, insertions: 0, deletions: 0 };
    }
  },
};
