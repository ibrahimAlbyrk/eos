import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { isSafeAbsPath, uiTokenOk } from "./fs-shared.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { FsOpenInRequestSchema } from "../../contracts/src/http.ts";

// A dialog waits on the user; the app answers when they choose or cancel.
const SHELL_PICK_TIMEOUT_MS = 30 * 60_000;

export function registerFsPickerRoutes(r: Router, c: Container): void {
  // Without a daemon-side picker the desktop app shows its own dialog.
  const pick = async <T>(own: () => Promise<T | null>, shellMethod: string): Promise<T | null | undefined> => {
    if (c.fs.canPick) return own();
    if (!c.appHost.isRegistered()) return undefined;
    return (await c.appHost.rpc("", shellMethod, [], SHELL_PICK_TIMEOUT_MS)) as T | null;
  };

  r.get("/pick-directory", async ({ res }) => {
    const picked = await pick(() => c.fs.pickDirectory(), "dialog.pickDirectory");
    if (picked === undefined) { writeJson(res, 501, { error: "no directory picker on this system" }); return; }
    if (!picked) { writeJson(res, 200, { cancelled: true }); return; }
    writeJson(res, 200, { path: picked });
  });

  r.get("/pick-file", async ({ res }) => {
    const picked = await pick(() => c.fs.pickFiles(), "dialog.pickFiles");
    if (picked === undefined) { writeJson(res, 501, { error: "no file picker on this system" }); return; }
    if (!picked?.length) { writeJson(res, 200, { cancelled: true }); return; }
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
      await c.fs.revealPath(body.path!);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  // Path-based "open in" — reveal in the file manager or open in an editor. Same
  // isSafeAbsPath guard + { ok }/500 error shape as /fs/reveal.
  r.post("/fs/open-in", async ({ req, res }) => {
    const body = validate(FsOpenInRequestSchema, await readBody(req));
    if (!isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    try {
      await c.fs.openIn(body.target, body.path, body.line, body.column);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  r.get("/fs/editors", ({ res }) => {
    writeJson(res, 200, { editors: c.fs.installedEditors() });
  });
}
