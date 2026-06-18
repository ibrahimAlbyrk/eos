// FileMemoryProvider — reads the configured memory sources (CLAUDE.md, AGENTS.md,
// …) for backends that run isolated from filesystem settings. Per source: the
// user-level paths (~ expands to the injected home) plus every projectFilename
// from the worker's cwd up to the repo root. The walk-up boundary is the nearest
// ancestor with a .git entry (a worktree's .git FILE counts), the explicit
// repoRoot bound, or the filesystem root. Each doc is tagged with its source's
// metadata. Missing/unreadable files are skipped silently — memory is best-effort
// context, never a spawn blocker.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { MemorySource } from "../../../contracts/src/memory.ts";
import type { MemoryProvider, MemoryScope, MemoryDoc, MemorySnapshot } from "../../../core/src/ports/MemoryProvider.ts";

export class FileMemoryProvider implements MemoryProvider {
  private readonly sources: readonly MemorySource[];
  private readonly home: string;

  constructor(sources: readonly MemorySource[], home: string = homedir()) {
    this.sources = sources;
    this.home = home;
  }

  load(scope: MemoryScope): MemorySnapshot {
    const dirs = projectDirs(scope.cwd, scope.repoRoot ?? null);
    const docs: MemoryDoc[] = [];
    for (const src of this.sources) {
      for (const userPath of src.userPaths) {
        const doc = this.read(this.expand(userPath), "user", src);
        if (doc) docs.push(doc);
      }
      for (const dir of dirs) {
        for (const filename of src.projectFilenames) {
          const doc = this.read(join(dir, filename), "project", src);
          if (doc) docs.push(doc);
        }
      }
    }
    return { docs };
  }

  private expand(p: string): string {
    if (p === "~") return this.home;
    if (p.startsWith("~/")) return join(this.home, p.slice(2));
    return p;
  }

  private read(path: string, level: MemoryDoc["level"], src: MemorySource): MemoryDoc | null {
    try {
      if (!existsSync(path)) return null;
      const content = readFileSync(path, "utf8");
      if (!content.trim()) return null;
      return { sourceId: src.id, sourceLabel: src.label, nativeFor: src.assumeNativeFor, path, level, content };
    } catch {
      return null;
    }
  }
}

// cwd → boundary (inclusive), reversed to root → cwd. Stops at the first of: a dir
// with a .git entry, the explicit repoRoot bound, or the filesystem root.
function projectDirs(cwd: string, repoRoot: string | null): string[] {
  const chain: string[] = [];
  let dir = cwd;
  while (true) {
    chain.push(dir);
    const parent = dirname(dir);
    const atGitRoot = existsSync(join(dir, ".git"));
    const atBound = repoRoot != null && dir === repoRoot;
    if (atGitRoot || atBound || parent === dir) break;
    dir = parent;
  }
  return chain.reverse();
}
