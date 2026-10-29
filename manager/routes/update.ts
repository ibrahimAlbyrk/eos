// In-app updates (contracts/src/update.ts, plan docs/updates/00-UPDATES-PLAN.md).
// All the dashboard's (ui-token) and local-only: another computer never updates
// or restarts this one.
//   GET  /api/update              the update state
//   POST /api/update/check        {trigger?} — look for a new release (manual = always)
//   POST /api/update/download     fetch the offered release (auto-download off)
//   POST /api/update/restart      {when: "now" | "idle"} — swap in the staged release
//   POST /api/update/later        stop waiting for agents
//   POST /api/update/dismiss      hide how the last swap ended
//   PUT  /api/settings/updates    {autoDownload}

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { patchConfigBlock } from "./settings.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import { UpdateCheckRequestSchema, UpdateRestartRequestSchema, UpdateSettingsPatchSchema } from "../../contracts/src/update.ts";

export function registerUpdateRoutes(r: Router, c: Container): void {
  const denied = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };
  const state = (res: ServerResponse, status = 200): void => writeJson(res, status, c.updates.state());

  r.get(ROUTES.update, ({ req, res }) => {
    if (denied(req, res)) return;
    state(res);
  });

  r.post(ROUTES.updateCheck, async ({ req, res }) => {
    if (denied(req, res)) return;
    const { trigger } = validate(UpdateCheckRequestSchema, await readBody(req));
    void c.updates.check(trigger);
    state(res, 202);
  });

  r.post(ROUTES.updateDownload, ({ req, res }) => {
    if (denied(req, res)) return;
    void c.updates.download();
    state(res, 202);
  });

  r.post(ROUTES.updateRestart, async ({ req, res }) => {
    if (denied(req, res)) return;
    const { when } = validate(UpdateRestartRequestSchema, await readBody(req));
    if (!c.updates.restart(when)) {
      writeJson(res, 409, { error: "no update is ready to restart into" });
      return;
    }
    state(res, 202);
  });

  r.post(ROUTES.updateLater, ({ req, res }) => {
    if (denied(req, res)) return;
    c.updates.later();
    state(res);
  });

  r.post(ROUTES.updateDismiss, async ({ req, res }) => {
    if (denied(req, res)) return;
    await c.updates.dismissNotice();
    state(res);
  });

  r.put(ROUTES.settingsUpdates, async ({ req, res }) => {
    if (denied(req, res)) return;
    const patch = validate(UpdateSettingsPatchSchema, await readBody(req));
    if (!patchConfigBlock(c, "updates", patch, res)) return;
    c.updates.settingsChanged();
    state(res);
  });
}
