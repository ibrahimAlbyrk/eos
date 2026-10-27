import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { isSafeAbsPath, uiTokenOk } from "./fs-shared.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { EDITOR_APPS, FsOpenInRequestSchema, type EditorId, type FsOpenInRequest } from "../../contracts/src/http.ts";

// Editors that open a file at a line through their own URL scheme
// (<scheme>://file/<path>:<line>:<column>); the rest open the file only.
const LINE_URL_SCHEMES: Partial<Record<EditorId, string>> = { vscode: "vscode", cursor: "cursor" };

// `open` argv per target. finder = reveal (`open -R <path>`, identical to
// /fs/reveal); an editor opens the path in that app. Pure so it's unit-testable
// without spawning.
export function openInArgv(target: FsOpenInRequest["target"], path: string, line?: number, column?: number): string[] {
  if (target === "finder") return ["-R", path];
  const scheme = LINE_URL_SCHEMES[target];
  if (scheme && line) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return [`${scheme}://file${encoded}:${line}${column ? `:${column}` : ""}`];
  }
  return ["-a", EDITOR_APPS[target], path];
}

// The editors installed in /Applications or ~/Applications, in EDITOR_APPS order.
export function installedEditors(exists: (_path: string) => boolean = existsSync): Array<{ id: EditorId; name: string }> {
  const dirs = ["/Applications", join(homedir(), "Applications")];
  return (Object.entries(EDITOR_APPS) as Array<[EditorId, string]>)
    .filter(([, name]) => dirs.some((d) => exists(join(d, `${name}.app`))))
    .map(([id, name]) => ({ id, name }));
}

export function registerFsPickerRoutes(r: Router, c: Container): void {
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

  // open / reveal / open-in launch apps on this Mac's screen, so only the
  // dashboard may call them (an agent holding the daemon URL must not).
  r.post("/fs/open", async ({ req, res }) => {
    const body = await readBody(req) as { path?: string };
    const isUrl = typeof body.path === "string" && /^https?:\/\//.test(body.path);
    if (!isUrl && !isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path or URL required" }); return; }
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    try {
      await c.fs.openPath(body.path!);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  r.post("/fs/reveal", async ({ req, res }) => {
    const body = await readBody(req) as { path?: string };
    if (!isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("open", ["-R", body.path]);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  // Path-based "open in" — reveal in Finder or open in an editor. Same
  // isSafeAbsPath guard + { ok }/500 error shape as /fs/reveal.
  r.post("/fs/open-in", async ({ req, res }) => {
    const body = validate(FsOpenInRequestSchema, await readBody(req));
    if (!isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("open", openInArgv(body.target, body.path, body.line, body.column));
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  r.get("/fs/editors", ({ res }) => {
    writeJson(res, 200, { editors: installedEditors() });
  });
}
