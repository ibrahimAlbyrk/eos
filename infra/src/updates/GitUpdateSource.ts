// GitUpdateSource — UpdateSource backed by the `git` binary. The "dedicated
// server" is just the configured remote: we fetch it and compare the current
// checkout to its upstream (@{u}). Every git call collapses to a benign value
// on failure, and a failed/timed-out fetch returns null (can't tell ⇒ offer
// nothing), so an offline or detached checkout never produces a false positive.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { UpdateSource, UpdateCheck, UpdateRevision } from "../../../core/src/ports/UpdateSource.ts";

const exec = promisify(execFile);

// The network fetch is the only slow step; local rev comparisons are instant.
const FETCH_TIMEOUT_MS = 15000;
const LOCAL_TIMEOUT_MS = 5000;

async function git(cwd: string, args: string[], timeoutMs = LOCAL_TIMEOUT_MS): Promise<string> {
  const { stdout } = await exec("git", ["-C", cwd, ...args], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitOr(cwd: string, args: string[], fallback: string): Promise<string> {
  try {
    return await git(cwd, args);
  } catch {
    return fallback;
  }
}

async function readNotes(cwd: string): Promise<UpdateRevision[]> {
  try {
    // Unit separator keeps subjects with punctuation parseable.
    const out = await git(cwd, ["log", "--format=%h%x1f%s", "HEAD..@{u}"]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((rec) => {
        const [sha, subject] = rec.split("\x1f");
        return { sha: sha ?? "", subject: subject ?? "" };
      })
      .filter((r) => r.sha.length > 0);
  } catch {
    return [];
  }
}

export const gitUpdateSource: UpdateSource = {
  async check(repoRoot: string): Promise<UpdateCheck | null> {
    try {
      if ((await git(repoRoot, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null;
      // No upstream → nothing to compare against (detached HEAD, no remote).
      const upstream = await gitOr(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], "");
      if (!upstream) return null;
      // The one step that talks to the network. A failure here (offline, auth)
      // aborts the whole check → null, never a stale "up to date / behind".
      await git(repoRoot, ["fetch", "--quiet"], FETCH_TIMEOUT_MS);

      const branch = await gitOr(repoRoot, ["branch", "--show-current"], "");
      const currentSha = await gitOr(repoRoot, ["rev-parse", "--short", "HEAD"], "");
      const latestSha = await gitOr(repoRoot, ["rev-parse", "--short", "@{u}"], "");
      const behind = Number.parseInt(await gitOr(repoRoot, ["rev-list", "--count", "HEAD..@{u}"], "0"), 10) || 0;
      const dirty = (await gitOr(repoRoot, ["status", "--porcelain"], "")).length > 0;
      const notes = behind > 0 ? await readNotes(repoRoot) : [];
      return { branch, currentSha, latestSha, behind, dirty, notes };
    } catch {
      return null;
    }
  },
};
