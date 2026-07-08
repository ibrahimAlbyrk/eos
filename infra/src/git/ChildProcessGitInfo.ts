// ChildProcessGitInfo — shells out to the `git` binary via execFile. Always
// runs in the target directory with `-C <cwd>` so cwd can't be tricked.
// Failures (missing repo, missing git, etc.) collapse to empty/zero values
// so callers can render a benign "no info" state instead of throwing.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import type { GitInfo, DiffStat, SyncStatus, ConflictEntry, GitDirs, StashOpResult } from "../../../core/src/ports/GitInfo.ts";
import type { PushState } from "../../../core/src/domain/push-plan.ts";
import type { PullState } from "../../../core/src/domain/pull-plan.ts";
import { isUnmergedCode } from "../../../core/src/domain/conflict.ts";
import type { ChangedFile, CommitDetail, CommitFile, FileDiffResponse, FsStashEntry, UnpushedCommit } from "../../../contracts/src/http.ts";
import { PATCH_MAX_BYTES, mergeChanges, mergeChangesWithBase, parseNameStatusZ, parseNumstatZ, parsePorcelainZ, truncatePatch } from "./changes-parse.ts";

const exec = promisify(execFile);

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

// %h%x1f%an%x1f%ct%x1f%s%x1e log records (unit-separated fields, record-
// terminated) → UnpushedCommit[]. Shared by unpushedCommits and log.
export function parseLogRecords(out: string): UnpushedCommit[] {
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
}

const LOG_FORMAT = "--format=%h%x1f%an%x1f%ct%x1f%s%x1e";

// %h%x1f%ct%x1f%gs%x1e stash-list records → FsStashEntry[]. Position IS the
// stash index (stash@{0} first). The branch rides in git's conventional
// reflog-subject prefix; custom messages without it yield branch null.
export function parseStashRecords(out: string): FsStashEntry[] {
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter((rec) => rec.split("\x1f")[0]?.length)
    .map((rec, index) => {
      const [sha, ct, subject] = rec.split("\x1f");
      const m = /^(?:WIP on|On) ([^:]+):/.exec(subject ?? "");
      return {
        index,
        sha: sha ?? "",
        subject: subject ?? "",
        ts: (Number.parseInt(ct ?? "", 10) || 0) * 1000,
        branch: m ? m[1] : null,
      };
    });
}

// Stash entries are MERGE commits (working tree merged over index state) —
// default `git show` renders merges as combined/empty diffs and numstat lists
// no files. first-parent diffs a merge against the pre-stash HEAD and leaves
// regular single-parent (and root) commits exactly as before.
const FIRST_PARENT_DIFF = "--diff-merges=first-parent";

// A rejected execFile carries git's stderr (and stdout) on the error object.
// Prefer stderr (the real message), fall back to the error message.
function gitErr(e: unknown): string {
  const stderr = (e as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return e instanceof Error ? e.message : String(e);
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
  async isRepo(cwd: string): Promise<boolean> {
    try {
      return (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
    } catch {
      return false;
    }
  },

  async gitDirs(cwd: string): Promise<GitDirs | null> {
    try {
      const toplevel = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
      const gitDir = (await runGit(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
      if (!toplevel || !gitDir) return null;
      // --git-common-dir prints an absolute path in a linked worktree but one
      // relative to cwd in the main checkout (often ".git") — normalize both.
      const commonRaw = (await runGit(cwd, ["rev-parse", "--git-common-dir"])).trim();
      const commonDir = commonRaw ? (isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw)) : gitDir;
      return { toplevel, gitDir, commonDir };
    } catch {
      return null;
    }
  },

  async listBranches(cwd: string): Promise<string[]> {
    try {
      const out = await runGit(cwd, ["branch", "--format=%(refname:short)"]);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },

  async remoteBranches(cwd: string): Promise<string[]> {
    try {
      const out = await runGit(cwd, ["branch", "-r", "--format=%(refname:short)"]);
      // Drop the symbolic "<remote>/HEAD" pointer — it's not a checkout target.
      return out.split("\n").map((s) => s.trim()).filter((b) => b && !b.endsWith("/HEAD"));
    } catch {
      return [];
    }
  },

  async remotes(cwd: string): Promise<string[]> {
    try {
      const out = await runGit(cwd, ["remote"]);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  },

  async currentBranch(cwd: string): Promise<string | null> {
    // `--show-current` (not `rev-parse --abbrev-ref HEAD`): resolves the
    // branch name even on an unborn HEAD (fresh init, no commits), and
    // prints empty on detached HEAD — same null semantics as before.
    try {
      const out = await runGit(cwd, ["branch", "--show-current"]);
      const name = out.trim();
      return name || null;
    } catch {
      return null;
    }
  },

  async recentCheckouts(cwd: string): Promise<string[]> {
    // HEAD reflog subjects, newest first: "checkout: moving from <A> to <B>".
    // Collect each <B> first-seen → most-recent-first, de-duplicated. Capped so
    // a long-lived repo's reflog can't blow runGit's buffer; the cap only drops
    // the cold tail, which the picker shows alphabetically anyway.
    try {
      const out = await runGit(cwd, ["reflog", "-n", "300", "--format=%gs"]);
      const seen = new Set<string>();
      for (const line of out.split("\n")) {
        const m = /^checkout: moving from .+ to (.+)$/.exec(line.trim());
        if (m) seen.add(m[1]);
      }
      return [...seen];
    } catch {
      return [];
    }
  },

  async checkout(cwd: string, branch: string): Promise<void> {
    await runGit(cwd, ["checkout", branch]);
  },

  async stashPush(cwd: string): Promise<void> {
    // `git stash push` exits 0 even with nothing to stash ("No local changes
    // to save"), so this is safe to call unconditionally before a switch.
    await runGit(cwd, ["stash", "push"]);
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
    const stat: DiffStat = { files: 0, insertions: 0, deletions: 0 };
    // Against HEAD: staged + unstaged vs the last commit. Against a base
    // (worktree fork point): also includes commits made after the fork —
    // a worktree agent that commits must not look "clean" in the UI.
    // Independent try blocks: on an unborn HEAD (fresh init, no commits) the
    // diff fails, but untracked files must still count below.
    try {
      const out = await runGit(cwd, ["diff", "--shortstat", ...SUBMODULE_IGNORE, base ?? "HEAD"]);
      Object.assign(stat, parseShortStat(out.trim()));
    } catch {}
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

  async pullState(cwd: string): Promise<PullState> {
    // Same branch + upstream + ahead/behind probe as pushState — project it to
    // the pull decision's input (no remote-target fallback needed for pull).
    const s = await childProcessGitInfo.pushState(cwd);
    return { branch: s.branch, hasUpstream: s.hasUpstream, ahead: s.ahead, behind: s.behind };
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
      const out = await runGit(cwd, ["log", "@{u}..HEAD", LOG_FORMAT]);
      return parseLogRecords(out);
    } catch {
      return [];
    }
  },

  async log(cwd: string, opts: { limit: number; skip: number }): Promise<UnpushedCommit[]> {
    try {
      // limit+1 so the route can answer hasMore without a second git call.
      const out = await runGit(cwd, ["log", "HEAD", "-n", String(opts.limit + 1), `--skip=${opts.skip}`, LOG_FORMAT]);
      return parseLogRecords(out);
    } catch {
      return [];
    }
  },

  async revParse(cwd: string, ref: string): Promise<string | null> {
    try {
      const out = (await runGit(cwd, ["rev-parse", "--short", ref])).trim();
      return out || null;
    } catch {
      return null;
    }
  },

  async commitPatch(cwd: string, sha: string): Promise<string | null> {
    try {
      // Same 32MB buffer as fullDiff — one commit's whole patch. Overflow
      // rejects → null → the route falls back to per-file diffs.
      const { stdout } = await exec("git", ["-C", cwd, "show", sha, FIRST_PARENT_DIFF, "--format=", "--patch", "--ignore-submodules=dirty"], {
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  },

  async commitFileDiff(cwd: string, sha: string, path: string, oldPath?: string): Promise<FileDiffResponse> {
    try {
      const out = await runGit(cwd, ["show", sha, FIRST_PARENT_DIFF, "--format=", "--", ...(oldPath ? [path, oldPath] : [path])]);
      if (/^Binary files .* differ$/m.test(out)) {
        return { path, patch: "", binary: true, truncated: false };
      }
      const t = truncatePatch(out, PATCH_MAX_BYTES);
      return { path, patch: t.patch, binary: false, truncated: t.truncated };
    } catch {
      return { path, patch: "", binary: false, truncated: false };
    }
  },

  async blobSizeAtRef(cwd: string, ref: string, path: string): Promise<number | null> {
    try {
      const out = (await runGit(cwd, ["cat-file", "-s", `${ref}:${path}`])).trim();
      const n = Number.parseInt(out, 10);
      return Number.isNaN(n) ? null : n;
    } catch {
      return null;
    }
  },

  async blobAtRef(cwd: string, ref: string, path: string): Promise<Uint8Array | null> {
    try {
      // encoding:"buffer" — blob bytes are opaque (images), never utf8-decode.
      const { stdout } = await exec("git", ["-C", cwd, "cat-file", "blob", `${ref}:${path}`], {
        maxBuffer: 32 * 1024 * 1024,
        encoding: "buffer",
      });
      return stdout;
    } catch {
      return null;
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
        runGit(cwd, ["show", sha, FIRST_PARENT_DIFF, "--name-status", "-z", "--format="]),
        runGit(cwd, ["show", sha, FIRST_PARENT_DIFF, "--numstat", "-z", "--format="]),
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

  async stashList(cwd: string): Promise<FsStashEntry[]> {
    try {
      const out = await runGit(cwd, ["stash", "list", "--format=%h%x1f%ct%x1f%gs%x1e"]);
      return parseStashRecords(out);
    } catch {
      return [];
    }
  },

  async stashApply(cwd: string, index: number): Promise<StashOpResult> {
    try {
      await runGit(cwd, ["stash", "apply", `stash@{${index}}`]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: gitErr(e) };
    }
  },

  async stashDrop(cwd: string, index: number): Promise<StashOpResult> {
    try {
      await runGit(cwd, ["stash", "drop", `stash@{${index}}`]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: gitErr(e) };
    }
  },

  async conflictCount(cwd: string): Promise<number> {
    try {
      const out = await runGit(cwd, ["status", "--porcelain", ...SUBMODULE_IGNORE]);
      let n = 0;
      for (const line of out.split("\n")) {
        if (isUnmergedCode(line.slice(0, 2))) n++;
      }
      return n;
    } catch {
      return 0;
    }
  },

  async conflictList(cwd: string): Promise<ConflictEntry[]> {
    try {
      const out = await runGit(cwd, ["status", "--porcelain=v1", "-z", ...SUBMODULE_IGNORE]);
      return parsePorcelainZ(out)
        .filter((e) => isUnmergedCode(e.x + e.y) && !e.path.startsWith(".eos/"))
        .map((e) => ({ path: e.path, xy: e.x + e.y }));
    } catch {
      return [];
    }
  },

  async conflictFileContent(cwd: string, path: string): Promise<string> {
    // The working-tree file carries the <<< === >>> markers git wrote — read it
    // off disk (the index has no stage-0 entry for an unmerged path).
    try {
      return await readFile(join(cwd, path), "utf8");
    } catch {
      return "";
    }
  },

  async stageContent(cwd: string, path: string, stage: 1 | 2 | 3): Promise<string | null> {
    // `git show :N:path` — 1=base, 2=ours, 3=theirs. Fails (→ null) when that
    // stage is absent, e.g. a side that deleted the file.
    try {
      return await runGit(cwd, ["show", `:${stage}:${path}`]);
    } catch {
      return null;
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

  async fullDiff(cwd: string, base?: string): Promise<string | null> {
    try {
      // Bigger buffer than runGit's: this is the whole tree in one patch.
      // Overflow rejects → null → the route falls back to per-file diffs.
      const { stdout } = await exec("git", ["-C", cwd, "diff", ...SUBMODULE_IGNORE, base ?? "HEAD"], {
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
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
