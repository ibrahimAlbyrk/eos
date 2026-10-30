// The git-scoped candidate-file set for a project root — the single source of
// truth shared by filename search (manager searchProject) and the tree-sitter
// symbol index. Tracked ∪ untracked (respecting .gitignore); a depth-5 walk
// fallback for non-git roots. Returns cwd-relative POSIX paths.

import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import { IGNORED_ENTRIES } from "../../../core/src/domain/fsIgnore.ts";

const exec = promisify(execFile);

// Tracked, then untracked: a single `--cached --others` call lists untracked
// files first, which would reorder search and references results.
export async function listCandidateFiles(cwd: string): Promise<string[]> {
  const ls = (...args: string[]) => exec("git", ["ls-files", "-z", ...args], { cwd, maxBuffer: 10 * 1024 * 1024 });
  try {
    const [tracked, untracked] = await Promise.all([ls(), ls("--others", "--exclude-standard")]);
    return [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")])].filter(Boolean);
  } catch {
    return walkFiles(cwd, "", 5);
  }
}

async function walkFiles(dir: string, rel: string, maxDepth: number): Promise<string[]> {
  if (maxDepth <= 0) return [];
  const results: string[] = [];
  try {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name.startsWith(".") || IGNORED_ENTRIES.has(item.name)) continue;
      const path = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) results.push(...(await walkFiles(join(dir, item.name), path, maxDepth - 1)));
      else results.push(path);
    }
  } catch {}
  return results;
}

const LIST_TTL_MS = 10_000;
const MAX_ROOTS = 8;

export interface CandidateFileCacheDeps {
  clock: Clock;
  list?: typeof listCandidateFiles;
}

// listCandidateFiles per root, shared by search and the symbol index. The
// container drops a root on the fs:change / git:change signals under it; the
// TTL bounds how stale a root no watcher covers can get.
export class CandidateFileCache {
  private readonly clock: Clock;
  private readonly listFiles: typeof listCandidateFiles;
  private readonly lists = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(deps: CandidateFileCacheDeps) {
    this.clock = deps.clock;
    this.listFiles = deps.list ?? listCandidateFiles;
  }

  list(root: string): Promise<string[]> {
    const now = this.clock.now();
    let entry = this.lists.get(root);
    this.lists.delete(root);
    if (!entry || now - entry.at >= LIST_TTL_MS) entry = { at: now, files: this.listFiles(root) };
    this.lists.set(root, entry); // Map order is the LRU order
    if (this.lists.size > MAX_ROOTS) this.lists.delete(this.lists.keys().next().value!);
    return entry.files;
  }

  roots(): string[] {
    return [...this.lists.keys()];
  }

  invalidate(root: string): void {
    this.lists.delete(root);
  }
}
