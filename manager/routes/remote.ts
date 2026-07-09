// Remote-pairing control routes — LOOPBACK + ui-token only (a local human action
// arming a pairing offer / arming the relay leg, NOT a remote control verb). The
// loopback-lock keeps these off-box; the ui-token separates the human UI from the
// on-box agent. The remote-control surface is the relay session exclusively; these
// routes are never in the §5.2.3 tier table (they classify as REFUSED if tunneled).

import type { Router } from "./Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";
import type { RemoteGatewayHandle, PairArmOptions } from "../remote/wire.ts";
import type { RemoteConfig } from "../../contracts/src/remote.ts";

export interface RemoteRoutesDeps {
  uiToken: string;
  // Read live: config.remote is reassigned by container.reloadConfig(), so the
  // routes must re-read it (not capture a boot snapshot) to see a Save take hold.
  getConfig: () => { remote: RemoteConfig; daemon: { port: number } };
  getGateway: () => RemoteGatewayHandle | null;
  // Arm/disarm the remote edge live for the current config (restart-free).
  arm: () => { enabled: boolean; armed: boolean };
}

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
}
