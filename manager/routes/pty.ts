import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import {
  PtyCreateRequestSchema,
  PtyInputRequestSchema,
  PtyResizeRequestSchema,
} from "../../contracts/src/http.ts";
import { PtyCapError } from "../services/PtySessionService.ts";

// Interactive multi-tab PTY routes. EVERY handler copies the UI-token gate the
// POST /terminal handler uses: a raw interactive shell is arbitrary exec, so an
// agent holding EOS_DAEMON_URL must never reach these. The daemon loopback-locks
// the port; the per-boot ui-token is the second lock.

export function registerPtyRoutes(r: Router, c: Container): void {
  r.post("/pty", async ({ req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(PtyCreateRequestSchema, await readBody(req));
    try {
      writeJson(res, 200, c.ptySessions.create(body));
    } catch (e) {
      if (e instanceof PtyCapError) { writeJson(res, 429, { error: e.message }); return; }
      throw e;
    }
  });

  r.get("/pty", ({ req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    writeJson(res, 200, { sessions: c.ptySessions.list() });
  });

  r.post(/^\/pty\/(?<id>[^/]+)\/input$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(PtyInputRequestSchema, await readBody(req));
    if (!c.ptySessions.input(params.id, body.data)) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, { ok: true });
  });

  r.post(/^\/pty\/(?<id>[^/]+)\/resize$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const body = validate(PtyResizeRequestSchema, await readBody(req));
    if (!c.ptySessions.resize(params.id, body.cols, body.rows)) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, { ok: true });
  });

  r.get(/^\/pty\/(?<id>[^/]+)\/buffer$/, ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const buf = c.ptySessions.buffer(params.id);
    if (!buf) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, buf);
  });

  r.del(/^\/pty\/(?<id>[^/]+)$/, ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) { writeJson(res, 403, { error: "ui token required" }); return; }
    if (!c.ptySessions.kill(params.id)) { writeJson(res, 404, { error: "session not found" }); return; }
    writeJson(res, 200, { ok: true });
  });
}
