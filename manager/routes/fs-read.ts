import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { isSafeAbsPath, listRootDir, searchProject } from "./fs-shared.ts";
import { errMsg } from "../../contracts/src/util.ts";

const PASTE_MAX_BYTES = 20 * 1024 * 1024;

function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        try { req.destroy(); } catch {}
        reject(new Error(`body too large (limit ${maxBytes})`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

export function registerFsReadRoutes(r: Router, c: Container): void {
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
      writeJson(res, 404, { error: errMsg(e) });
    }
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

  r.get("/fs/read", ({ url, res }) => {
    const qPath = url.searchParams.get("path");
    if (!isSafeAbsPath(qPath)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    try {
      const content = readFileSync(qPath, "utf8");
      const lines = content.split("\n").length;
      writeJson(res, 200, { path: qPath, content, lines });
    } catch (e) {
      writeJson(res, 404, { error: errMsg(e) });
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
      writeJson(res, 500, { error: errMsg(e) });
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
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  r.post("/fs/paste", async ({ req, res }) => {
    const ct = req.headers["content-type"] ?? "";
    if (!ct.startsWith("application/octet-stream")) {
      writeJson(res, 400, { error: "content-type must be application/octet-stream" });
      return;
    }
    const name = req.headers["x-filename"];
    if (typeof name !== "string" || !name) {
      writeJson(res, 400, { error: "x-filename header required" });
      return;
    }
    try {
      const buf = await readRawBody(req, PASTE_MAX_BYTES);
      const dir = mkdtempSync(join(tmpdir(), "eos-paste-"));
      const dest = join(dir, name.replace(/[/\0]/g, "_"));
      writeFileSync(dest, buf);
      writeJson(res, 200, { path: dest });
    } catch (e) {
      writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
