// Remote-pairing control routes — LOOPBACK + ui-token only (a local human action
// arming a pairing offer / arming the relay leg, NOT a remote control verb). The
// loopback-lock keeps these off-box; the ui-token separates the human UI from the
// on-box agent. The remote-control surface is the relay session exclusively; these
// routes are never in the §5.2.3 tier table (they classify as REFUSED if tunneled).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Router } from "./Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";
import { errMsg } from "../../contracts/src/util.ts";
import type { RemoteGatewayHandle, PairArmOptions } from "../remote/wire.ts";
import { RemoteConfigSchema, type RemoteConfig } from "../../contracts/src/remote.ts";

export interface RemoteRoutesDeps {
  uiToken: string;
  // Read live: config.remote is reassigned by container.reloadConfig(), so the
  // routes must re-read it (not capture a boot snapshot) to see a Save take hold.
  // `daemon.home` locates ~/.eos/config.json for the config-write route.
  getConfig: () => { remote: RemoteConfig; daemon: { port: number; home: string } };
  getGateway: () => RemoteGatewayHandle | null;
  // Arm/disarm the remote edge live for the current config (restart-free).
  arm: () => { enabled: boolean; armed: boolean };
  // Reload the on-disk config into the container after a config write, so a
  // subsequent arm() rebuilds from the just-saved value. Mirrors the archive route.
  reloadConfig: () => void;
}

// The app-writable slice of config.remote (Settings > Remote): the enable flag
// + relay URL. .strict() so a typoed key 400s instead of silently landing in
// config.json. `relay.url` is validated as a URL by RemoteConfigSchema's shape.
const RemoteConfigPatchSchema = RemoteConfigSchema.pick({ enabled: true, relay: true }).partial().strict();

// Relay-only: the QR is minted from the daemon's already-armed room + bearer, so
// arming a pairing offer needs no topology from config beyond the display window.
function buildArmOptions(): PairArmOptions {
  return {};
}

export function registerRemoteRoutes(router: Router, deps: RemoteRoutesDeps): void {
  const tokenOk = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
    constantTimeEqual(req.headers["x-eos-ui-token"], deps.uiToken);

  router.get("/api/remote/status", ({ req, res }) => {
    if (!tokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    writeJson(res, 200, { enabled: deps.getConfig().remote.enabled, armed: deps.getGateway() != null });
  });

  // Arm/disarm the remote edge for the config currently on disk — restart-free.
  // The app calls this right after writing config.remote (Save), so enabling
  // remote goes live immediately. config.reloadConfig() must run before arm() so
  // the rebuild reads the new config; the daemon's handler wires that in. The
  // room id + bearer are auto-minted/loaded by the gateway build (RoomSecrets).
  router.post("/api/remote/arm", ({ req, res }) => {
    if (!tokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    writeJson(res, 200, deps.arm());
  });

  router.post("/api/remote/pair", ({ req, res }) => {
    if (!tokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const gateway = deps.getGateway();
    if (!gateway) { writeJson(res, 409, { error: "remote not armed; enable + set relay URL + Save" }); return; }
    const qr = gateway.armPairing(buildArmOptions());
    writeJson(res, 200, qr);
  });

  // Persist config.remote to ~/.eos/config.json — the app-facing WRITE the
  // Settings toggle calls before arming (arm() reads config from disk). Field-
  // merges the patch into the on-disk `remote` key, then reloads so a subsequent
  // arm() rebuilds from the saved value. Mirrors PUT /api/settings/archive.
  router.put("/api/remote/config", async ({ req, res }) => {
    if (!tokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const patch = validate(RemoteConfigPatchSchema, await readBody(req));
    try {
      const path = join(deps.getConfig().daemon.home, "config.json");
      const existing = readConfigJson(path);
      const remote = existing.remote && typeof existing.remote === "object"
        ? (existing.remote as Record<string, unknown>)
        : {};
      existing.remote = { ...remote, ...patch };
      writeFileSync(path, JSON.stringify(existing, null, 2));
      deps.reloadConfig();
    } catch (e) {
      writeJson(res, 500, { error: `failed to write config: ${errMsg(e)}` });
      return;
    }
    writeJson(res, 200, { remote: deps.getConfig().remote });
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
