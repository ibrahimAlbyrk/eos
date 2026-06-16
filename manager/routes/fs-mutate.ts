// Files-explorer mutation routes: create / rename / move / trash, plus the
// watch subscribe/unsubscribe pair. Every handler is thin — validate the body,
// gate on the UI token, sandbox each path within the supplied root
// (resolveWithinRoot), then delegate to c.files. Domain errors thrown by the
// adapter (ConflictError, NotFoundError, …) are mapped to status codes by the
// central error handler, so handlers don't catch them.

import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import {
  FsCreateRequestSchema,
  FsMoveRequestSchema,
  FsRenameRequestSchema,
  FsTrashRequestSchema,
  FsUnwatchRequestSchema,
  FsWatchRequestSchema,
} from "../../contracts/src/http.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { guardMutation, resolveWithinRoot, uiTokenOk } from "./fs-shared.ts";

// True when `child` is `parent` itself or nested inside it — used to reject
// moving a directory into its own subtree.
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function registerFsMutateRoutes(r: Router, c: Container): void {
  r.post("/fs/create", async ({ req, res }) => {
    const body = validate(FsCreateRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.root, c.uiToken)) return;
    const target = resolveWithinRoot(body.root, body.path);
    if (!target) {
      writeJson(res, 400, { error: "path escapes root" });
      return;
    }
    if (body.type === "directory") await c.files.mkdir(target);
    else await c.files.createFile(target, body.content);
    writeJson(res, 200, { ok: true, path: target });
  });

  r.post("/fs/rename", async ({ req, res }) => {
    const body = validate(FsRenameRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.root, c.uiToken)) return;
    const from = resolveWithinRoot(body.root, body.path);
    if (!from) {
      writeJson(res, 400, { error: "path escapes root" });
      return;
    }
    // newName is a validated bare filename, so the target is provably inside
    // the same (already-sandboxed) directory.
    const to = join(dirname(from), body.newName);
    await c.files.rename(from, to);
    writeJson(res, 200, { ok: true, path: to });
  });

  r.post("/fs/move", async ({ req, res }) => {
    const body = validate(FsMoveRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.root, c.uiToken)) return;
    const destDir = resolveWithinRoot(body.root, body.destDir);
    if (!destDir) {
      writeJson(res, 400, { error: "destDir escapes root" });
      return;
    }
    const results: { from: string; ok: boolean; error?: string }[] = [];
    for (const p of body.paths) {
      const from = resolveWithinRoot(body.root, p);
      if (!from) {
        results.push({ from: p, ok: false, error: "path escapes root" });
        continue;
      }
      const to = join(destDir, basename(from));
      if (to === from) {
        results.push({ from: p, ok: false, error: "already in destination" });
        continue;
      }
      if (isInside(from, destDir)) {
        results.push({ from: p, ok: false, error: "cannot move a folder into itself" });
        continue;
      }
      try {
        await c.files.move(from, to, { overwrite: body.overwrite });
        results.push({ from: p, ok: true });
      } catch (e) {
        results.push({ from: p, ok: false, error: errMsg(e) });
      }
    }
    writeJson(res, 200, { ok: results.every((x) => x.ok), results });
  });

  r.post("/fs/trash", async ({ req, res }) => {
    const body = validate(FsTrashRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.root, c.uiToken)) return;
    const trashed: string[] = [];
    const failed: { path: string; error: string }[] = [];
    for (const p of body.paths) {
      const target = resolveWithinRoot(body.root, p);
      if (!target) {
        failed.push({ path: p, error: "path escapes root" });
        continue;
      }
      try {
        await c.files.trash(target);
        trashed.push(p);
      } catch (e) {
        failed.push({ path: p, error: errMsg(e) });
      }
    }
    writeJson(res, 200, { ok: failed.length === 0, trashed, failed });
  });

  // Watch / unwatch are UI-token gated too: they consume server file
  // descriptors, so an agent holding EOS_DAEMON_URL must not open arbitrary
  // watches. clientId ties the watch to the SSE connection (FsWatchRegistry).
  r.post("/fs/watch", async ({ req, res }) => {
    const body = validate(FsWatchRequestSchema, await readBody(req));
    if (!guardMutation(req, res, body.root, c.uiToken)) return;
    const dir = resolveWithinRoot(body.root, body.dir);
    if (!dir) {
      writeJson(res, 400, { error: "dir escapes root" });
      return;
    }
    c.fsWatchRegistry.watch(body.clientId, dir);
    writeJson(res, 200, { ok: true });
  });

  r.post("/fs/unwatch", async ({ req, res }) => {
    const body = validate(FsUnwatchRequestSchema, await readBody(req));
    if (!uiTokenOk(req, c.uiToken)) {
      writeJson(res, 403, { error: "ui token required" });
      return;
    }
    if (body.all) {
      c.fsWatchRegistry.dropClient(body.clientId);
    } else if (body.root && body.dir) {
      const dir = resolveWithinRoot(body.root, body.dir);
      if (dir) c.fsWatchRegistry.unwatch(body.clientId, dir);
    }
    writeJson(res, 200, { ok: true });
  });
}
