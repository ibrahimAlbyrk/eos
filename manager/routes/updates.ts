// Auto-update routes. status/check are read-only; defer is a harmless session
// flag; apply triggers a system rebuild + daemon restart, so it is uiToken-
// gated — an agent holding EOS_DAEMON_URL must never be able to self-update the
// host. The native launch splash passes the token (it reads ~/.eos/ui-token).

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { UpdateApplyRequestSchema } from "../../contracts/src/http.ts";

export function registerUpdateRoutes(r: Router, c: Container): void {
  r.get("/api/updates/status", ({ res }) => writeJson(res, 200, c.updates.getStatus()));

  // Force a fresh fetch + compare — the native launch splash calls this so its
  // apply decision isn't stale in the first seconds after a daemon boot.
  r.post("/api/updates/check", async ({ res }) => writeJson(res, 200, await c.updates.check()));

  r.post("/api/updates/defer", ({ res }) =>
    writeJson(res, 200, { ok: true, deferred: c.updates.defer().deferred }),
  );

  r.post("/api/updates/apply", async ({ req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) {
      writeJson(res, 403, { error: "ui token required" });
      return;
    }
    const body = validate(UpdateApplyRequestSchema, await readBody(req));
    const result = c.updates.apply(body.relaunchApp);
    writeJson(res, result.started ? 202 : 409, result);
  });
}
