import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { errMsg } from "../../contracts/src/util.ts";

import { SettingsPatchRequestSchema } from "../../contracts/src/http.ts";

// Partial archive-config patch (Settings > General). Mirrors the archive
// section of DaemonConfigOverrideSchema; strict so a typoed key 400s instead
// of silently landing in config.json.
const ArchiveConfigPatchSchema = z.object({
  retention: z.enum(["off", "daily", "weekly", "monthly"]),
  purgeOnAppClose: z.boolean(),
  cmdW: z.enum(["archive", "delete"]),
}).partial().strict();

export function registerSettingsRoutes(r: Router, c: Container): void {
  r.get("/api/settings", ({ res }) => {
    writeJson(res, 200, { settings: c.userSettings.read() });
  });

  r.put("/api/settings", async ({ req, res }) => {
    const body = validate(SettingsPatchRequestSchema, await readBody(req));
    writeJson(res, 200, { settings: c.userSettings.patch(body.settings) });
  });

  // Archive lifecycle config lives in ~/.eos/config.json (NOT settings.json):
  // the daemon's retention sweeper and the app-closed purge endpoint read
  // config.archive live. GET reads the merged view; PUT field-merges the patch
  // into the on-disk file's archive key then reloads — the backends route
  // idiom — so the sweeper sees it without a restart.
  r.get("/api/settings/archive", ({ res }) => {
    writeJson(res, 200, { archive: c.config.archive });
  });

  r.put("/api/settings/archive", async ({ req, res }) => {
    const patch = validate(ArchiveConfigPatchSchema, await readBody(req));
    try {
      const path = join(c.config.daemon.home, "config.json");
      const existing = readConfigJson(path);
      const archive = existing.archive && typeof existing.archive === "object"
        ? (existing.archive as Record<string, unknown>)
        : {};
      existing.archive = { ...archive, ...patch };
      writeFileSync(path, JSON.stringify(existing, null, 2));
      c.reloadConfig();
    } catch (e) {
      writeJson(res, 500, { error: `failed to write config: ${errMsg(e)}` });
      return;
    }
    writeJson(res, 200, { archive: c.config.archive });
  });
}

function readConfigJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
