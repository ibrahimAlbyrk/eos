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
import type { Router } from "../../routes/Router.ts";
import { writeJson } from "../../middleware/errorHandler.ts";
import { readBody } from "../../middleware/bodyReader.ts";
import { validate } from "../../middleware/validate.ts";
import { uiTokenOk } from "../../routes/fs-shared.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { UpdateCheckRequestSchema, UpdateRestartRequestSchema, UpdateSettingsPatchSchema } from "../../../contracts/src/update.ts";
import type { UpdateService } from "./UpdateService.ts";
import type { RouteAccess } from "../../routes/route-access.ts";

export interface UpdateRouteDeps {
  readonly updates: UpdateService;
  readonly uiToken: string;
  // Writes one config.json block and reloads the config (throws when it can't).
  patchConfig(key: string, patch: Record<string, unknown>): void;
}

// This Mac's own app: another computer may not update or restart it.
export const UPDATE_ROUTE_ACCESS: RouteAccess = { localOnly: [["*", "/api/update/*"], ["*", "/api/settings/updates"]] };

export function registerUpdateRoutes(r: Router, c: UpdateRouteDeps): void {
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
    try {
      c.patchConfig("updates", patch);
    } catch (e) {
      writeJson(res, 500, { error: `failed to write config: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    c.updates.settingsChanged();
    state(res);
  });
}
