// Worktree hydration. A fresh worktree has only tracked files — no
// node_modules, no .env — so the agent cannot build or test on turn one.
// We clone the source checkout's dependency dirs in via APFS clonefile
// (cp -c: instant, near-zero disk), falling back to a size-capped plain copy
// off APFS. Every candidate is gated by `git check-ignore` in the SOURCE repo:
// hydrating a non-ignored path would make the worktree permanently dirty and
// break teardown's clean/preserve decision. Symlinked node_modules are skipped
// — Node realpath-resolves them straight back into the user's checkout.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const MAX_SCAN_DEPTH = 4;
// Plain-copy fallback cap (KB). Clonefile has no cap — it is cheap.
const PLAIN_COPY_CAP_KB = 1024 * 1024; // 1 GiB

export interface HydrationItem {
  path: string; // repo-relative
  status: "cloned" | "copied" | "skipped" | "failed";
  reason?: string;
}

export interface HydrateInput {
  repoRoot: string;
  worktreeDir: string;
  includeEnvFiles: boolean;
  log(m: string): void;
}

function run(cmd: string, args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function findTargets(root: string): { nodeModules: string[]; envFiles: string[] } {
  const nodeModules: string[] = [];
  const envFiles: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === ".eos") continue;
        if (e.name === "node_modules") { nodeModules.push(abs); continue; }
        if (depth < MAX_SCAN_DEPTH) walk(abs, depth + 1);
      } else if (e.isFile() && /^\.env(\..+)?$/.test(e.name)) {
        envFiles.push(abs);
      }
    }
  };
  walk(root, 1);
  return { nodeModules, envFiles };
}

function isIgnoredInSource(repoRoot: string, rel: string): boolean {
  return run("git", ["check-ignore", "-q", rel], repoRoot).code === 0;
}

function sizeKb(path: string): number {
  const r = run("du", ["-sk", path]);
  const n = Number.parseInt(r.stdout.split("\t")[0] ?? "", 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function copyInto(src: string, dst: string): HydrationItem["status"] | "too-large" {
  mkdirSync(dirname(dst), { recursive: true });
  // Clonefile first. cp -c fails fast off APFS (or across filesystems).
  if (run("cp", ["-Rc", src, dst]).code === 0) return "cloned";
  if (sizeKb(src) > PLAIN_COPY_CAP_KB) return "too-large";
  return run("cp", ["-R", src, dst]).code === 0 ? "copied" : "failed";
}

export function hydrateWorktree(input: HydrateInput): HydrationItem[] {
  const { repoRoot, worktreeDir, log } = input;
  const items: HydrationItem[] = [];
  const { nodeModules, envFiles } = findTargets(repoRoot);
  const candidates = [...nodeModules, ...(input.includeEnvFiles ? envFiles : [])];

  for (const src of candidates) {
    const rel = relative(repoRoot, src);
    if (!isIgnoredInSource(repoRoot, rel)) {
      items.push({ path: rel, status: "skipped", reason: "not gitignored in source — would dirty the worktree" });
      log(`hydrate: skip ${rel} (not gitignored)`);
      continue;
    }
    const dst = join(worktreeDir, rel);
    if (existsSync(dst)) {
      items.push({ path: rel, status: "skipped", reason: "already exists in worktree" });
      continue;
    }
    const outcome = copyInto(src, dst);
    if (outcome === "too-large") {
      items.push({ path: rel, status: "skipped", reason: `over plain-copy cap (${PLAIN_COPY_CAP_KB}KB) and clonefile unavailable` });
      log(`hydrate: skip ${rel} (too large for plain copy)`);
    } else {
      items.push({ path: rel, status: outcome });
      log(`hydrate: ${outcome} ${rel}`);
    }
  }
  return items;
}
