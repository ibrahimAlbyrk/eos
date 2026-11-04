// Plugins (contracts/src/plugin.ts):
//   GET  /api/plugins                    every plugin folder, its state and settings,
//                                        and the folder plugins live in
//   GET  /api/plugins/:id                one
//   GET  /api/plugins/:id/status[?wait=1] one, with the windows' latest report; wait=1
//                                        first lets a pending rebuild finish and a
//                                        window load it (≤ 5 s) — for an agent that
//                                        just wrote the files
//   POST /api/plugins/:id/report         { rev, ok, error? } from a window (ui token)
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
  PluginEnabledRequestSchema, PluginIdSchema, PluginReportRequestSchema, PluginSettingsRequestSchema, PluginStoreKeySchema,
  PluginStoreRequestSchema,
} from "../../contracts/src/plugin.ts";

export interface PluginRouteDeps {
  readonly plugins: PluginService;
  readonly uiToken: string;
  // Where plugin folders go (~/.eos/plugins).
  readonly dir: string;
}

const SETTLE_TIMEOUT_MS = 5000;
const SETTLE_POLL_MS = 100;

const ONE = /^\/api\/plugins\/(?<id>[^/]+)$/;
const STATUS = /^\/api\/plugins\/(?<id>[^/]+)\/status$/;
const REPORT = /^\/api\/plugins\/(?<id>[^/]+)\/report$/;
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
    writeJson(res, 200, { plugins: c.plugins.list(), dir: c.dir });
  });

  r.get(STATUS, async ({ params, url, res }) => {
    const id = validate(PluginIdSchema, params.id);
    if (url.searchParams.get("wait") === "1") await settled(c.plugins, id);
    writeJson(res, 200, { plugin: c.plugins.get(id), report: c.plugins.lastReport(id), busy: c.plugins.isBusy(id) });
  });

  r.post(REPORT, async ({ req, res, params }) => {
    if (denied(req, res)) return;
    const body = validate(PluginReportRequestSchema, await readBody(req));
    c.plugins.report(validate(PluginIdSchema, params.id), body, Date.now());
    writeJson(res, 200, { ok: true });
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

// Until the folder has been seen, no rebuild is pending and a window has
// reported on the current build (or there's nothing to load), or the timeout.
async function settled(plugins: PluginService, id: string): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = plugins.list().find((p) => p.id === id);
    if (info && !plugins.isBusy(id) && (!info.hasUi || plugins.lastReport(id)?.rev === info.rev)) return;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}
