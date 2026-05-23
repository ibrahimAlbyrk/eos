import { readFileSync } from "node:fs";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { BranchesQuerySchema } from "../../contracts/src/http.ts";

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
    if (!isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    try {
      await c.fs.openPath(body.path);
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
    const [branches, current] = await Promise.all([
      c.git.listBranches(q.cwd),
      c.git.currentBranch(q.cwd),
    ]);
    writeJson(res, 200, { branches, current });
  });

  r.get("/fs/recents", ({ res }) => {
    writeJson(res, 200, { paths: c.recents.list() });
  });
}
