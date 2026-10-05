import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import { SyncJoinRequestSchema } from "../../contracts/src/sync.ts";

// Settings › Sync. Status is open; the key and every change are the user's (ui-token).
// All of it is local-only (route-planes.ts) — the key never crosses a facade.
export function registerSyncRoutes(r: Router, c: Container): void {
  const denied = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };

  r.get(ROUTES.sync, ({ res }) => {
    writeJson(res, 200, c.sync.status());
  });

  r.get(ROUTES.syncKey, ({ req, res }) => {
    if (denied(req, res)) return;
    const key = c.sync.key();
    if (!key) { writeJson(res, 404, { error: "sync is off" }); return; }
    writeJson(res, 200, { key });
  });

  r.post(ROUTES.syncCreate, ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, c.sync.create());
  });

  r.post(ROUTES.syncJoin, async ({ req, res }) => {
    if (denied(req, res)) return;
    const body = validate(SyncJoinRequestSchema, await readBody(req));
    writeJson(res, 200, c.sync.join(body.key));
  });

  r.post(ROUTES.syncNow, ({ req, res }) => {
    if (denied(req, res)) return;
    c.sync.syncNow();
    writeJson(res, 202, c.sync.status());
  });

  r.post(ROUTES.syncLeave, ({ req, res }) => {
    if (denied(req, res)) return;
    writeJson(res, 200, c.sync.leave());
  });
}
