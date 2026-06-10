// ChildProcessGitInfo — shells out to the `git` binary via execFile. Always
// runs in the target directory with `-C <cwd>` so cwd can't be tricked.
// Failures (missing repo, missing git, etc.) collapse to empty/zero values
// so callers can render a benign "no info" state instead of throwing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitInfo, DiffStat, SyncStatus } from "../../../core/src/ports/GitInfo.ts";
import type { PushState } from "../../../core/src/domain/push-plan.ts";
import type { ChangedFile, CommitDetail, CommitFile, FileDiffResponse, UnpushedCommit } from "../../../contracts/src/http.ts";
import { mergeChanges, mergeChangesWithBase, parseNameStatusZ, parseNumstatZ, parsePorcelainZ, truncatePatch } from "./changes-parse.ts";

const exec = promisify(execFile);

const PATCH_MAX_BYTES = 256 * 1024;

// A submodule's working-tree noise (the `-dirty` suffix from modified/untracked
// content inside it) is not the agent's change — suppress it across every
// status/diff so the count, the file list, and the per-file patch agree.
// Genuine committed pointer moves still surface (that's `=dirty`, not `=all`).
const SUBMODULE_IGNORE = ["--ignore-submodules=dirty"];

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

// `git diff --no-index` exits 1 when the files differ — the promisified
// execFile REJECTS with the patch sitting in e.stdout. Recover it.
async function runGitDiffNoIndex(cwd: string, path: string): Promise<string> {
  try {
    return await runGit(cwd, ["diff", "--no-index", "--", "/dev/null", path]);
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.length > 0) return stdout;
    throw e;
  }
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

  async diffShortStat(cwd: string, base?: string): Promise<DiffStat> {
    try {
      // Against HEAD: staged + unstaged vs the last commit. Against a base
      // (worktree fork point): also includes commits made after the fork —
      // a worktree agent that commits must not look "clean" in the UI.
      const out = await runGit(cwd, ["diff", "--shortstat", ...SUBMODULE_IGNORE, base ?? "HEAD"]);
      const stat = parseShortStat(out.trim());
      // `git diff` never reports untracked files — an agent whose only change
      // is a NEW file must not look clean either. Count them into `files`
      // (line counts unknown); --exclude-standard keeps gitignored noise out.
      // Managed worktrees live INSIDE the repo at .eos/ — never count
      // them as user changes (same filter as the changes listing).
      try {
        const untracked = await runGit(cwd, ["ls-files", "--others", "--exclude-standard"]);
        stat.files += untracked
          .split("\n")
          .filter((l) => l && !l.startsWith(".eos/") && l !== ".eos")
          .length;
      } catch {}
      return stat;
    } catch {
      return { files: 0, insertions: 0, deletions: 0 };
    }
  },

  async mergeBase(cwd: string, otherRepoRoot: string): Promise<string | null> {
    try {
      const other = (await runGit(otherRepoRoot, ["rev-parse", "HEAD"])).trim();
      if (!other) return null;
      // Worktree + source share one object store, so the sha resolves here.
      const base = (await runGit(cwd, ["merge-base", "HEAD", other])).trim();
      return base || null;
    } catch {
      return null;
    }
  },

  async syncStatus(cwd: string): Promise<SyncStatus | null> {
    try {
      // `--left-right --count A...B` prints "<behind>\t<ahead>" when A=@{u}, B=HEAD.
      const out = await runGit(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
      const parts = out.trim().split(/\s+/);
      const behind = parseInt(parts[0] ?? "0", 10);
      const ahead = parseInt(parts[1] ?? "0", 10);
      if (Number.isNaN(ahead) || Number.isNaN(behind)) return null;
      return { ahead, behind };
    } catch {
      // No upstream configured, detached HEAD, etc.
      return null;
    }
  },

  async pushState(cwd: string): Promise<PushState> {
    let branch: string | null = null;
    let remote: string | null = null;
    let hasUpstream = false;
    let ahead = 0;
    let behind = 0;

    try {
      const b = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      branch = b && b !== "HEAD" ? b : null;
    } catch {}

    // Upstream ref (e.g. "origin/feature/x") → presence + its remote name.
    try {
      const up = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).trim();
      if (up) {
        hasUpstream = true;
        remote = up.split("/")[0] || null;
      }
    } catch {}

    if (hasUpstream) {
      try {
        const out = (await runGit(cwd, ["rev-list", "--left-right", "--count", "@{u}...HEAD"])).trim();
        const parts = out.split(/\s+/);
        behind = parseInt(parts[0] ?? "0", 10) || 0;
        ahead = parseInt(parts[1] ?? "0", 10) || 0;
      } catch {}
    }

    // No upstream yet → pick the push target: prefer origin, else the only remote.
    if (!remote) {
      try {
        const remotes = (await runGit(cwd, ["remote"])).split("\n").map((s) => s.trim()).filter(Boolean);
        remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
      } catch {}
    }

    return { branch, remote, hasUpstream, ahead, behind };
  },

  async hasUncommittedChanges(cwd: string): Promise<boolean> {
    try {
      const out = await runGit(cwd, ["status", "--porcelain", ...SUBMODULE_IGNORE]);
      // Managed worktrees live inside the repo at .eos/ — never count them as
      // user changes (same filter as diffShortStat's untracked listing).
      return out
        .split("\n")
        .map((l) => l.slice(3).trim())
        .filter((p) => p && !p.startsWith(".eos/") && p !== ".eos")
        .length > 0;
    } catch {
      return false;
    }
  },

  async unpushedCommits(cwd: string): Promise<UnpushedCommit[]> {
    try {
      // Unit separators keep subjects with any punctuation parseable; record
      // separator terminates each commit. No upstream → git errors → [].
      const out = await runGit(cwd, ["log", "@{u}..HEAD", "--format=%h%x1f%an%x1f%ct%x1f%s%x1e"]);
      return out
        .split("\x1e")
        .map((r) => r.trim())
        .filter(Boolean)
        .map((rec) => {
          const [sha, author, ct, subject] = rec.split("\x1f");
          return {
            sha: sha ?? "",
            author: author ?? "",
            ts: (Number.parseInt(ct ?? "", 10) || 0) * 1000,
            subject: subject ?? "",
          };
        })
        .filter((c) => c.sha.length > 0);
    } catch {
      return [];
    }
  },

  async commitDetail(cwd: string, sha: string): Promise<CommitDetail | null> {
    try {
      const meta = await runGit(cwd, ["show", "-s", `--format=%h%x1f%an%x1f%ct%x1f%s%x1f%b`, sha]);
      const [short, author, ct, subject, body] = meta.split("\x1f");
      if (!short?.trim()) return null;
      // Reuse the -z parsers: name-status gives per-file status letters,
      // numstat the per-file line counts.
      const [nameStatus, numstat] = await Promise.all([
        runGit(cwd, ["show", sha, "--name-status", "-z", "--format="]),
        runGit(cwd, ["show", sha, "--numstat", "-z", "--format="]),
      ]);
      const counts = new Map(parseNumstatZ(numstat).map((n) => [n.path, n]));
      const files: CommitFile[] = parseNameStatusZ(nameStatus).map((e) => ({
        path: e.path,
        ...(e.oldPath ? { oldPath: e.oldPath } : {}),
        status: e.status,
        insertions: counts.get(e.path)?.insertions ?? null,
        deletions: counts.get(e.path)?.deletions ?? null,
      }));
      return {
        sha: short.trim(),
        author: author ?? "",
        ts: (Number.parseInt(ct ?? "", 10) || 0) * 1000,
        subject: subject ?? "",
        body: (body ?? "").trim(),
        insertions: files.reduce((n, f) => n + (f.insertions ?? 0), 0),
        deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
        files,
      };
    } catch {
      return null;
    }
  },

  async stashCount(cwd: string): Promise<number> {
    try {
      const out = await runGit(cwd, ["stash", "list", "--format=%H"]);
      const trimmed = out.trim();
      return trimmed ? trimmed.split("\n").length : 0;
    } catch {
      return 0;
    }
  },

  async conflictCount(cwd: string): Promise<number> {
    try {
      const out = await runGit(cwd, ["status", "--porcelain", ...SUBMODULE_IGNORE]);
      let n = 0;
      for (const line of out.split("\n")) {
        const xy = line.slice(0, 2);
        // Conflict combos per git docs: DD AU UD UA DU AA UU.
        if (xy === "DD" || xy === "AU" || xy === "UD" || xy === "UA" || xy === "DU" || xy === "AA" || xy === "UU") {
          n++;
        }
      }
      return n;
    } catch {
      return 0;
    }
  },

  async changedFiles(cwd: string, base?: string): Promise<ChangedFile[]> {
    try {
      const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "-uall", ...SUBMODULE_IGNORE]);
      if (base) {
        // diff <base> covers committed-after-fork + uncommitted tracked work;
        // porcelain contributes only untracked files on top.
        const nameStatus = await runGit(cwd, ["diff", "--name-status", "-z", ...SUBMODULE_IGNORE, base]);
        const numstat = await runGit(cwd, ["diff", "--numstat", "-z", ...SUBMODULE_IGNORE, base]);
        return mergeChangesWithBase(parseNameStatusZ(nameStatus), parsePorcelainZ(status), parseNumstatZ(numstat));
      }
      let numstat = "";
      // No HEAD yet (fresh repo) → degrade to status-only entries, null counts.
      try { numstat = await runGit(cwd, ["diff", "--numstat", "-z", ...SUBMODULE_IGNORE, "HEAD"]); } catch {}
      return mergeChanges(parsePorcelainZ(status), parseNumstatZ(numstat));
    } catch {
      return [];
    }
  },

  async fileDiff(cwd: string, path: string, oldPath?: string, base?: string): Promise<FileDiffResponse> {
    try {
      // Single-file porcelain decides tracked vs untracked authoritatively —
      // covers staged deletes, which `ls-files` would misreport as untracked.
      const st = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--", path]);
      const out = st.startsWith("??")
        ? await runGitDiffNoIndex(cwd, path)
        : await runGit(cwd, ["diff", ...SUBMODULE_IGNORE, base ?? "HEAD", "--", ...(oldPath ? [path, oldPath] : [path])]);
      if (/^Binary files .* differ$/m.test(out)) {
        return { path, patch: "", binary: true, truncated: false };
      }
      const t = truncatePatch(out, PATCH_MAX_BYTES);
      return { path, patch: t.patch, binary: false, truncated: t.truncated };
    } catch {
      return { path, patch: "", binary: false, truncated: false };
    }
  },
};
