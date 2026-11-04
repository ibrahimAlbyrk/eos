import { z } from "zod";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { errMsg } from "../../contracts/src/util.ts";

import { SettingsPatchRequestSchema } from "../../contracts/src/http.ts";
import { CompactionConfigSchema, patchConfigFile } from "../shared/config.ts";

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
    // This route takes no ui-token, so an agent could reach it — and undo a
    // choice only the user may make (a feature's protectedSettings).
    for (const p of c.protectedSettings()) {
      const gated = p.keys.filter((k) => Object.hasOwn(body.settings, k));
      if (gated.length) {
        writeJson(res, 403, { error: `${gated.join(", ")} ${gated.length === 1 ? "is" : "are"} set only through ${p.via}` });
        return;
      }
    }
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
    if (!patchConfigBlock(c, "archive", patch, res)) return;
    writeJson(res, 200, { archive: c.config.archive });
  });

  // Context compaction (Settings > General): same config.json idiom — the
  // idle-edge trigger reads config.compaction live after the reload.
  r.get("/api/settings/compaction", ({ res }) => {
    writeJson(res, 200, { compaction: c.config.compaction });
  });

  r.put("/api/settings/compaction", async ({ req, res }) => {
    const patch = validate(CompactionConfigSchema.partial().strict(), await readBody(req));
    if (!patchConfigBlock(c, "compaction", patch, res)) return;
    writeJson(res, 200, { compaction: c.config.compaction });
  });
}

// Field-merges `patch` into the on-disk config.json block `key`, then reloads —
// the backends route idiom. Writes the 500 itself and returns false on failure.
export function patchConfigBlock(
  c: Container,
  key: string,
  patch: Record<string, unknown>,
  res: Parameters<typeof writeJson>[0],
): boolean {
  try {
    patchConfigFile(c.config.daemon.home, key, patch);
    c.reloadConfig();
    return true;
  } catch (e) {
    writeJson(res, 500, { error: `failed to write config: ${errMsg(e)}` });
    return false;
  }
}

