// The git-scoped candidate-file set for a project root — the single source of
// truth shared by filename search (manager searchProject) and the tree-sitter
// symbol index. Tracked ∪ untracked (respecting .gitignore); a depth-5 walk
// fallback for non-git roots. Returns cwd-relative POSIX paths.

import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { IGNORED_ENTRIES } from "../../../core/src/domain/fsIgnore.ts";

export function listCandidateFiles(cwd: string): string[] {
  try {
    const tracked = execSync("git ls-files", { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return [...new Set([...tracked.trim().split("\n"), ...untracked.trim().split("\n")])].filter(Boolean);
  } catch {
    return walkFiles(cwd, cwd, 5);
  }
}

function walkFiles(base: string, dir: string, maxDepth: number): string[] {
  if (maxDepth <= 0) return [];
  const results: string[] = [];
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".") || IGNORED_ENTRIES.has(item.name)) continue;
      const full = join(dir, item.name);
      const rel = full.slice(base.length + 1);
      if (item.isDirectory()) {
        results.push(...walkFiles(base, full, maxDepth - 1));
      } else {
        results.push(rel);
      }
    }
  } catch {}
  return results;
}
