import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename } from "node:path";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { BranchesQuerySchema } from "../../contracts/src/http.ts";

interface FsEntry {
  name: string;
  absolutePath: string;
  relativePath: string;
  type: "file" | "directory";
}

const IGNORED = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".next", ".nuxt", "dist", "build", ".cache"]);

function sortEntries(a: FsEntry, b: FsEntry): number {
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function listRootDir(cwd: string): FsEntry[] {
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

function searchProject(cwd: string, query: string, limit: number): FsEntry[] {
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

function isSafeAbsPath(p: unknown): p is string {
  return typeof p === "string" && p.startsWith("/") && !p.includes("\0");
}

export function registerFsRoutes(r: Router, c: Container): void {
  r.get("/pick-directory", async ({ res }) => {
    if (process.platform !== "darwin") {
      writeJson(res, 501, { error: "directory picker only implemented on macOS" });
      return;
    }
    const picked = await c.fs.pickDirectory();
    if (!picked) { writeJson(res, 200, { cancelled: true }); return; }
    writeJson(res, 200, { path: picked });
  });

  r.get("/pick-file", async ({ res }) => {
    if (process.platform !== "darwin") {
      writeJson(res, 501, { error: "file picker only implemented on macOS" });
      return;
    }
    const picked = await c.fs.pickFiles();
    if (!picked) { writeJson(res, 200, { cancelled: true }); return; }
    writeJson(res, 200, { paths: picked });
  });

  r.get("/fs/image", ({ url, res }) => {
    const qPath = url.searchParams.get("path");
    if (!isSafeAbsPath(qPath)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    try {
      const data = readFileSync(qPath);
      const ext = qPath.split(".").pop()?.toLowerCase() ?? "";
      const mimeMap: Record<string, string> = {
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
        gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
        bmp: "image/bmp", ico: "image/x-icon",
      };
      res.writeHead(200, {
        "content-type": mimeMap[ext] ?? "application/octet-stream",
        "cache-control": "public, max-age=86400",
      });
      res.end(data);
    } catch (e) {
      writeJson(res, 404, { error: (e as Error).message });
    }
  });

  r.get("/fs/default-app", async ({ url, res }) => {
    const qPath = url.searchParams.get("path");
    const qExt = url.searchParams.get("ext");
    if (!qPath && !qExt) { writeJson(res, 400, { error: "path or ext required" }); return; }
    if (qPath && !isSafeAbsPath(qPath)) { writeJson(res, 400, { error: "path must be absolute" }); return; }
    const info = await c.fs.resolveDefaultApp({
      path: qPath ?? undefined,
      ext: qExt ?? undefined,
    });
    if (!info) { writeJson(res, 200, { app: null }); return; }
    writeJson(res, 200, {
      app: {
        bundleId: info.bundleId,
        bundlePath: info.bundlePath,
        appName: info.appName,
        iconUrl: info.bundleId ? `/fs/icon?bundleId=${encodeURIComponent(info.bundleId)}` : null,
      },
    });
  });

  r.get("/fs/icon", async ({ url, res }) => {
    const bundleId = url.searchParams.get("bundleId");
    if (!bundleId) { writeJson(res, 400, { error: "bundleId required" }); return; }
    const path = await c.fs.iconPathForBundleId(bundleId);
    if (!path) {
      writeJson(res, 404, { error: "bundle not resolved yet — query /fs/default-app first" });
      return;
    }
    res.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "public, max-age=86400",
    });
    res.end(readFileSync(path));
  });

  r.post("/fs/open", async ({ req, res }) => {
    const body = await readBody(req) as { path?: string };
    const isUrl = typeof body.path === "string" && /^https?:\/\//.test(body.path);
    if (!isUrl && !isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path or URL required" }); return; }
    try {
      await c.fs.openPath(body.path!);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: (e as Error).message });
    }
  });

  r.get("/fs/branches", async ({ url, res }) => {
    const q = validate(BranchesQuerySchema, {
      cwd: url.searchParams.get("cwd") ?? undefined,
    });
    if (!isSafeAbsPath(q.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    const [branches, current, remoteUrl] = await Promise.all([
      c.git.listBranches(q.cwd),
      c.git.currentBranch(q.cwd),
      c.git.remoteUrl(q.cwd),
    ]);
    const isGit = branches.length > 0 || current !== null;
    writeJson(res, 200, { branches, current, isGit, remoteUrl });
  });

  r.post("/fs/checkout", async ({ req, res }) => {
    const body = await readBody(req) as { cwd?: string; branch?: string };
    if (!isSafeAbsPath(body.cwd)) { writeJson(res, 400, { error: "cwd must be absolute" }); return; }
    if (typeof body.branch !== "string") { writeJson(res, 400, { error: "branch required" }); return; }
    try {
      await c.git.checkout(body.cwd, body.branch);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 400, { error: (e as Error).message });
    }
  });

  r.get("/fs/recents", ({ res }) => {
    writeJson(res, 200, { paths: c.recents.list() });
  });

  r.post("/fs/reveal", async ({ req, res }) => {
    const body = await readBody(req) as { path?: string };
    if (!isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    try {
      const { execSync } = await import("node:child_process");
      execSync(`open -R "${body.path}"`);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: (e as Error).message });
    }
  });

  r.get("/fs/read", ({ url, res }) => {
    const qPath = url.searchParams.get("path");
    if (!isSafeAbsPath(qPath)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    try {
      const content = readFileSync(qPath, "utf8");
      const lines = content.split("\n").length;
      writeJson(res, 200, { path: qPath, content, lines });
    } catch (e) {
      writeJson(res, 404, { error: (e as Error).message });
    }
  });

  r.get("/fs/list", ({ url, res }) => {
    const cwd = url.searchParams.get("cwd");
    if (!isSafeAbsPath(cwd)) { writeJson(res, 400, { error: "cwd required" }); return; }
    const query = (url.searchParams.get("query") ?? "").trim().toLowerCase();
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    try {
      const entries = query ? searchProject(cwd, query, limit) : listRootDir(cwd);
      writeJson(res, 200, { entries });
    } catch (e) {
      writeJson(res, 500, { error: (e as Error).message });
    }
  });

  r.post("/fs/write", async ({ req, res }) => {
    const body = await readBody(req) as { path?: string; content?: string };
    if (!isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    if (typeof body.content !== "string") { writeJson(res, 400, { error: "content required" }); return; }
    try {
      writeFileSync(body.path, body.content, "utf8");
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: (e as Error).message });
    }
  });
}
