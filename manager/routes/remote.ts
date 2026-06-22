// Remote-pairing control routes — LOOPBACK + ui-token only (a local human action
// arming a pairing offer, NOT a remote control verb). The loopback-lock keeps
// these off-box; the ui-token separates the human UI from the on-box agent. The
// remote-control surface is the /ws gateway exclusively; these routes are never
// in the §8 tier table (they classify as REFUSED if ever tunneled).

import type { Router } from "./Router.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";
import type { RemoteGatewayHandle, PairArmOptions } from "../remote/wire.ts";
import type { RemoteConfig } from "../../contracts/src/remote.ts";

export interface RemoteRoutesDeps {
  uiToken: string;
  config: { remote: RemoteConfig; daemon: { port: number } };
  getGateway: () => RemoteGatewayHandle | null;
}

function buildArmOptions(config: RemoteRoutesDeps["config"]): PairArmOptions {
  const r = config.remote;
  if (r.mode === "relay" && r.relay?.url && r.relay?.room) {
    return { relay: { url: r.relay.url, room: r.relay.room }, lan: [] };
  }
  if (r.mode === "lan") {
    // The daemon's /ws is plain ws today (no LAN TLS yet — relay mode is the
    // TLS path); the address is a dial hint, payloads stay E2E-encrypted.
    const host = r.lan?.host;
    return { lan: host ? [`ws://${host}:${config.daemon.port}/ws`] : [], relay: null, lanSpki: null };
  }
  return { lan: [], relay: null };
}

export function registerRemoteRoutes(router: Router, deps: RemoteRoutesDeps): void {
  const tokenOk = (req: { headers: Record<string, string | string[] | undefined> }): boolean =>
    constantTimeEqual(req.headers["x-eos-ui-token"], deps.uiToken);

  router.get("/api/remote/status", ({ req, res }) => {
    if (!tokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    writeJson(res, 200, { mode: deps.config.remote.mode, armed: deps.getGateway() != null });
  });

  router.post("/api/remote/pair", ({ req, res }) => {
    if (!tokenOk(req)) { writeJson(res, 403, { error: "ui token required" }); return; }
    const gateway = deps.getGateway();
    if (!gateway) { writeJson(res, 409, { error: "remote not armed; set config.remote.mode and restart" }); return; }
    const qr = gateway.armPairing(buildArmOptions(deps.config));
    writeJson(res, 200, qr);
  });
}
