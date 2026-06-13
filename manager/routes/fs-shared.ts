import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename } from "node:path";

export interface FsEntry {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: "file" | "directory";
}

export const IGNORED = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".next", ".nuxt", "dist", "build", ".cache"]);

export function isSafeAbsPath(p: unknown): p is string {
  return typeof p === "string" && p.startsWith("/") && !p.includes("\0");
}

// UI-origin token gate. Mutating /fs git routes (branch admin, fetch, pull,
// checkout) require the per-boot x-eos-ui-token so an agent holding
// EOS_DAEMON_URL cannot mutate the user's repo through the daemon API.
export function uiTokenOk(req: { headers: Record<string, string | string[] | undefined> }, expected: string): boolean {
  return req.headers["x-eos-ui-token"] === expected;
}

export function sortEntries(a: FsEntry, b: FsEntry): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function listRootDir(cwd: string): FsEntry[] {
  const items = readdirSync(cwd, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const item of items) {
    if (item.name.startsWith(".") || IGNORED.has(item.name)) continue;
    entries.push({
      name: item.name,
      absolutePath: join(cwd, item.name),
      relativePath: item.name,
      type: item.isDirectory() ? "directory" : "file",
    });
  }
  return entries.sort(sortEntries);
}

function scoreMatch(name: string, relPath: string, query: string): number {
  const lName = name.toLowerCase();
  const lPath = relPath.toLowerCase();
  if (lName === query) return 100;
  if (lName.startsWith(query)) return 80;
  if (lName.includes(query)) return 60;
  if (lPath.includes(query)) return 30;
  return 0;
}

export function searchProject(cwd: string, query: string, limit: number): FsEntry[] {
  let fileList: string[];
  try {
    const tracked = execSync("git ls-files", { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    fileList = [...new Set([...tracked.trim().split("\n"), ...untracked.trim().split("\n")])].filter(Boolean);
  } catch {
    fileList = walkFiles(cwd, cwd, 5);
  }

  const scored: { entry: FsEntry; score: number }[] = [];
  const seenDirs = new Set<string>();

  for (const f of fileList) {
    const parts = f.split("/");
    let dirPath = "";
    for (let i = 0; i < parts.length - 1; i++) {
      dirPath = dirPath ? dirPath + "/" + parts[i] : parts[i];
      if (seenDirs.has(dirPath)) continue;
      seenDirs.add(dirPath);
      const s = scoreMatch(parts[i], dirPath, query);
      if (s > 0) {
        scored.push({ entry: { name: parts[i], absolutePath: join(cwd, dirPath), relativePath: dirPath, type: "directory" }, score: s + 1 });
      }
    }
  }

  for (const f of fileList) {
    const name = basename(f);
    const s = scoreMatch(name, f, query);
    if (s > 0) {
      scored.push({ entry: { name, absolutePath: join(cwd, f), relativePath: f, type: "file" }, score: s });
    }
  }

  scored.sort((a, b) => b.score - a.score || sortEntries(a.entry, b.entry));
  return scored.slice(0, limit).map((s) => s.entry);
}

function walkFiles(base: string, dir: string, maxDepth: number): string[] {
  if (maxDepth <= 0) return [];
  const results: string[] = [];
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".") || IGNORED.has(item.name)) continue;
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
