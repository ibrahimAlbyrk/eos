import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { IGNORED_ENTRIES } from "../../core/src/domain/fsIgnore.ts";
import { listCandidateFiles } from "../../infra/src/filesystem/gitCandidateFiles.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";

export interface FsEntry {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: "file" | "directory";
}

// Single source lives in core/domain/fsIgnore. Re-exported here so existing
// route imports keep working.
export const IGNORED = IGNORED_ENTRIES;

export function isSafeAbsPath(p: unknown): p is string {
  return typeof p === "string" && p.startsWith("/") && !p.includes("\0");
}

// ext → mime for raw image responses (/fs/image, /fs/blob). Unknown extensions
// fall back to application/octet-stream at the call site.
export const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  bmp: "image/bmp", ico: "image/x-icon",
};

// Reject absolute paths and `..` traversal — every git path the UI sends is
// repo-relative (same predicate as the worker changes/file routes).
export function repoRelative(p: string): boolean {
  return p.length > 0 && !p.startsWith("/") && !p.split("/").includes("..");
}

// UI-origin token gate. Mutating /fs git routes (branch admin, fetch, pull,
// checkout) require the per-boot x-eos-ui-token so an agent holding
// EOS_DAEMON_URL cannot mutate the user's repo through the daemon API.
export function uiTokenOk(req: { headers: Record<string, string | string[] | undefined> }, expected: string): boolean {
  return constantTimeEqual(req.headers["x-eos-ui-token"], expected);
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
  // Same git-scoped candidate set the symbol index parses (DRY).
  const fileList = listCandidateFiles(cwd);

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

// realpath the deepest existing ancestor of `abs` and re-append the missing
// tail. Lets resolveWithinRoot validate to-be-created paths (create/mkdir),
// while still resolving symlinks in the existing portion.
function realpathNearest(abs: string): string {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length ? resolve(real, ...tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs; // hit filesystem root, nothing resolved
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

// Sandbox guard: returns the resolved absolute target IFF it stays inside
// `root`, else null. realpaths BOTH sides so a symlink inside root that points
// out is caught (plain ".." normalization can't see that) — this is why
// isSafeAbsPath alone is insufficient for the explorer's destructive ops.
export function resolveWithinRoot(root: unknown, target: unknown): string | null {
  if (typeof root !== "string" || typeof target !== "string") return null;
  if (root.includes("\0") || target.includes("\0")) return null;
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    return null;
  }
  const real = realpathNearest(resolve(realRoot, target));
  const rel = relative(realRoot, real);
  if (rel === "") return real; // target === root
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null; // escaped
  return real;
}

// UI-origin mutation gate, shared by fs-git and fs-mutate: the path must be a
// safe absolute path AND the request must carry the per-boot x-eos-ui-token.
export function guardMutation(
  req: { headers: Record<string, string | string[] | undefined> },
  res: Parameters<typeof writeJson>[0],
  cwd: unknown,
  uiToken: string,
): boolean {
  if (!isSafeAbsPath(cwd)) {
    writeJson(res, 400, { error: "cwd must be absolute" });
    return false;
  }
  if (!uiTokenOk(req, uiToken)) {
    writeJson(res, 403, { error: "ui token required" });
    return false;
  }
  return true;
}
