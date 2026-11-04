// Plugins (contracts/src/plugin.ts):
//   GET  /api/plugins                    every plugin folder, its state and settings
//   GET  /api/plugins/:id                one
//   PUT  /api/plugins/:id/enabled        { enabled }            (ui token)
//   PUT  /api/plugins/:id/settings       { values }             (ui token)
//   GET  /api/plugins/:id/store/:key     { value }
//   PUT  /api/plugins/:id/store/:key     { value }              (ui token)
//   GET  /ui/plugins/:id/:rev.js|.css    a build, by revision — served under
//                                        /ui/ beside the dashboard, so a window
//                                        loads it the way it loads its own code

import type { Router } from "../routes/Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "../routes/fs-shared.ts";
import type { PluginService } from "../../core/src/services/PluginService.ts";
import {
  PluginEnabledRequestSchema, PluginIdSchema, PluginSettingsRequestSchema, PluginStoreKeySchema, PluginStoreRequestSchema,
} from "../../contracts/src/plugin.ts";

export interface PluginRouteDeps {
  readonly plugins: PluginService;
  readonly uiToken: string;
}

const ONE = /^\/api\/plugins\/(?<id>[^/]+)$/;
const ENABLED = /^\/api\/plugins\/(?<id>[^/]+)\/enabled$/;
const SETTINGS = /^\/api\/plugins\/(?<id>[^/]+)\/settings$/;
const STORE = /^\/api\/plugins\/(?<id>[^/]+)\/store\/(?<key>[^/]+)$/;
const BUILD = /^\/ui\/plugins\/(?<id>[^/]+)\/(?<rev>\d+)\.(?<ext>js|css)$/;

// Registered before the dashboard bundle's /ui/* catch-all.
export function registerPluginBundleRoutes(r: Router, c: PluginRouteDeps): void {
  r.get(BUILD, ({ params, res }) => {
    const build = c.plugins.bundle(params.id, Number(params.rev));
    const body = params.ext === "js" ? build?.js : build?.css;
    if (body == null) { writeJson(res, 404, { error: "not found" }); return; }
    res.setHeader("content-type", params.ext === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
    // A revision never changes; a new build gets a new one.
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.writeHead(200);
    res.end(body);
  });
}

export function registerPluginRoutes(r: Router, c: PluginRouteDeps): void {
  const denied = (req: Parameters<typeof uiTokenOk>[0], res: Parameters<typeof writeJson>[0]): boolean => {
    if (uiTokenOk(req, c.uiToken)) return false;
    writeJson(res, 403, { error: "ui token required" });
    return true;
  };

  r.get("/api/plugins", ({ res }) => {
    writeJson(res, 200, { plugins: c.plugins.list() });
  });

  r.get(ONE, ({ params, res }) => {
    writeJson(res, 200, { plugin: c.plugins.get(validate(PluginIdSchema, params.id)) });
  });

  r.put(ENABLED, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const body = validate(PluginEnabledRequestSchema, await readBody(req));
    writeJson(res, 200, { plugin: await c.plugins.setEnabled(validate(PluginIdSchema, params.id), body.enabled) });
  });

  r.put(SETTINGS, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const body = validate(PluginSettingsRequestSchema, await readBody(req));
    writeJson(res, 200, { plugin: c.plugins.setSettings(validate(PluginIdSchema, params.id), body.values) });
  });

  r.get(STORE, ({ params, res }) => {
    const value = c.plugins.storeValue(validate(PluginIdSchema, params.id), validate(PluginStoreKeySchema, params.key));
    writeJson(res, 200, { value: value ?? null });
  });

  r.put(STORE, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const body = validate(PluginStoreRequestSchema, await readBody(req));
    c.plugins.setStoreValue(validate(PluginIdSchema, params.id), validate(PluginStoreKeySchema, params.key), body.value);
    writeJson(res, 200, { ok: true });
  });
}
