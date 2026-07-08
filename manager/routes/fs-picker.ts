import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { isSafeAbsPath } from "./fs-shared.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { FsOpenInRequestSchema, type FsOpenInRequest } from "../../contracts/src/http.ts";

// `open` argv per target (mirrors workers.ts OPEN_TARGETS). finder = reveal
// (`open -R <path>`, identical to /fs/reveal); vscode opens the file in the
// editor. Pure so it's unit-testable without spawning.
const OPEN_IN_PREFIX: Record<FsOpenInRequest["target"], string[]> = {
  finder: ["-R"],
  vscode: ["-a", "Visual Studio Code"],
};

export function openInArgv(target: FsOpenInRequest["target"], path: string): string[] {
  return [...OPEN_IN_PREFIX[target], path];
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

  r.post("/fs/open", async ({ req, res }) => {
    const body = await readBody(req) as { path?: string };
    const isUrl = typeof body.path === "string" && /^https?:\/\//.test(body.path);
    if (!isUrl && !isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path or URL required" }); return; }
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
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("open", ["-R", body.path]);
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });

  // Path-based "open in" for gitdiff file rows — reveal in Finder or open in
  // VS Code. Same isSafeAbsPath guard + { ok }/500 error shape as /fs/reveal.
  r.post("/fs/open-in", async ({ req, res }) => {
    const body = validate(FsOpenInRequestSchema, await readBody(req));
    if (!isSafeAbsPath(body.path)) { writeJson(res, 400, { error: "absolute path required" }); return; }
    try {
      const { execFileSync } = await import("node:child_process");
      execFileSync("open", openInArgv(body.target, body.path));
      writeJson(res, 200, { ok: true });
    } catch (e) {
      writeJson(res, 500, { error: errMsg(e) });
    }
  });
}
