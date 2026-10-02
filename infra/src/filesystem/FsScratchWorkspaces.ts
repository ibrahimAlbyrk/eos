// FsScratchWorkspaces — ScratchWorkspaces on the local disk. Each folder is
// <root>/<workerId>, made a git repo with one empty commit: sub-agent worktrees
// need a HEAD to fork from and the diff panel needs one to compare against.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ScratchWorkspaces } from "../../../core/src/ports/ScratchWorkspaces.ts";
import { encodeCwd } from "../../../core/src/domain/claude-paths.ts";

const exec = promisify(execFile);

// Fixed identity, no signing, no hooks: the first commit must not depend on the user's git config.
const COMMIT_ENV = { GIT_AUTHOR_NAME: "eos", GIT_AUTHOR_EMAIL: "eos@local", GIT_COMMITTER_NAME: "eos", GIT_COMMITTER_EMAIL: "eos@local" };

export interface FsScratchWorkspacesOptions {
  // Parent of every scratch folder (~/.eos/scratch).
  root: string;
  // Claude's per-folder data dir (~/.claude/projects): transcripts + memory.
  claudeProjectsDir: string;
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export function createFsScratchWorkspaces(opts: FsScratchWorkspacesOptions): ScratchWorkspaces {
  const git = (dir: string, args: string[], env?: Record<string, string>) =>
    exec("git", ["-C", dir, ...args], env ? { env: { ...process.env, ...env } } : {});

  return {
    async create(workerId) {
      const dir = join(opts.root, workerId);
      mkdirSync(dir, { recursive: true });
      try {
        await git(dir, ["init", "-q"]);
        await git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", "Eos scratch folder"], COMMIT_ENV);
      } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
      }
      return dir;
    },

    async remove(dir) {
      if (dirname(dir) !== opts.root) return;
      // Claude keys its data by the realpath — resolve it while the folder still exists.
      let real = dir;
      try { real = realpathSync(dir); } catch { /* already gone: the raw path stands in */ }
      const encoded = encodeCwd(real);
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      // The agent's own Claude data, plus its sub-agents' (their worktrees live in <dir>/.eos/worktrees/).
      for (const name of subdirs(opts.claudeProjectsDir)) {
        if (name === encoded || name.startsWith(`${encoded}--eos-worktrees-`)) {
          await rm(join(opts.claudeProjectsDir, name), { recursive: true, force: true });
        }
      }
    },

    list() {
      return subdirs(opts.root).map((name) => join(opts.root, name));
    },
  };
}
