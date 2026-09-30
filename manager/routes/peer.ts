// Eos ↔ Eos peering routes (contracts/src/peer.ts).
//
// Hosting (/api/peer…) and controlling (/api/hosts…) are the human's settings:
// loopback + ui-token, never reachable from a paired device (route-planes.ts).
// GET /api/host is an open read — a controlling UI learns who it is talking to
// through the host facade.

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { readBody } from "../middleware/bodyReader.ts";
import { validate } from "../middleware/validate.ts";
import { uiTokenOk } from "./fs-shared.ts";
import { patchConfigBlock } from "./settings.ts";
import { ConnectHostRequestSchema, PeerUpdateRequestSchema, UpdateHostRequestSchema } from "../../contracts/src/peer.ts";
import { isFingerprint } from "../../core/src/domain/peer.ts";
import { PairingError } from "../peer/HostLinkService.ts";
import { pairWith } from "../peer/pair-mutual.ts";
import { errMsg } from "../../contracts/src/util.ts";

const FP = "(?<fp>[0-9a-f]{64})";

export function registerPeerRoutes(r: Router, c: Container): void {
  const gate = (req: Parameters<typeof uiTokenOk>[0], res: Parameters<typeof writeJson>[0]): boolean => {
    if (uiTokenOk(req, c.uiToken)) return true;
    writeJson(res, 403, { error: "ui token required" });
    return false;
  };

  r.get("/api/host", ({ res }) => writeJson(res, 200, c.peerHost.hostInfo()));

  // ---- hosting: who may control this Mac ------------------------------------
  r.get("/api/peer", ({ req, res }) => {
    if (!gate(req, res)) return;
    writeJson(res, 200, c.peerHost.status());
  });

  r.put("/api/peer", async ({ req, res }) => {
    if (!gate(req, res)) return;
    const patch = validate(PeerUpdateRequestSchema, await readBody(req));
    if (!patchConfigBlock(c, "peer", patch, res)) return;
    await c.peerHost.reconcile();
    writeJson(res, 200, c.peerHost.status());
  });

  r.post("/api/peer/invite", ({ req, res }) => {
    if (!gate(req, res)) return;
    if (!c.config.peer.enabled) { writeJson(res, 409, { error: "turn on remote access first" }); return; }
    writeJson(res, 200, c.peerHost.createInvite());
  });

  r.del("/api/peer/invite", ({ req, res }) => {
    if (!gate(req, res)) return;
    writeJson(res, 200, { cancelled: c.peerHost.cancelInvites() });
  });

  r.del(new RegExp(`^/api/peer/devices/${FP}$`), ({ req, res, params }) => {
    if (!gate(req, res)) return;
    if (!c.peerHost.revoke(params.fp)) { writeJson(res, 404, { error: "no such device" }); return; }
    writeJson(res, 200, { ok: true });
  });

  r.post(new RegExp(`^/api/peer/devices/${FP}/disconnect$`), ({ req, res, params }) => {
    if (!gate(req, res)) return;
    writeJson(res, 200, { disconnected: c.peerHost.disconnect(params.fp) });
  });

  // ---- controlling: the computers this Mac drives ---------------------------
  r.get("/api/hosts", ({ req, res }) => {
    if (!gate(req, res)) return;
    writeJson(res, 200, { hosts: c.hostLinks.list() });
  });

  r.post("/api/hosts", async ({ req, res }) => {
    if (!gate(req, res)) return;
    const body = validate(ConnectHostRequestSchema, await readBody(req));
    // "Let it control this Mac too" is hosting — the person just asked for it.
    if (body.mutual && !c.config.peer.enabled) {
      if (!patchConfigBlock(c, "peer", { enabled: true }, res)) return;
      await c.peerHost.reconcile();
    }
    try {
      writeJson(res, 200, await pairWith(c.peerHost, c.hostLinks, body.invite, { alias: body.alias, mutual: body.mutual }));
    } catch (e) {
      if (e instanceof PairingError) { writeJson(res, e.status, { error: e.message }); return; }
      writeJson(res, 502, { error: errMsg(e) });
    }
  });

  r.put(new RegExp(`^/api/hosts/${FP}$`), async ({ req, res, params }) => {
    if (!gate(req, res)) return;
    const patch = validate(UpdateHostRequestSchema, await readBody(req));
    const view = c.hostLinks.update(params.fp, patch);
    if (!view) { writeJson(res, 404, { error: "unknown computer" }); return; }
    writeJson(res, 200, view);
  });

  r.del(new RegExp(`^/api/hosts/${FP}$`), ({ req, res, params }) => {
    if (!gate(req, res)) return;
    if (!isFingerprint(params.fp) || !c.hostLinks.forget(params.fp)) { writeJson(res, 404, { error: "unknown computer" }); return; }
    c.viewTokens.revokeHost(params.fp);
    writeJson(res, 200, { ok: true });
  });

  r.post(new RegExp(`^/api/hosts/${FP}/view-token$`), ({ req, res, params }) => {
    if (!gate(req, res)) return;
    if (!c.hostLinks.get(params.fp)) { writeJson(res, 404, { error: "unknown computer" }); return; }
    writeJson(res, 200, { token: c.viewTokens.mint(params.fp) });
  });

  r.post(new RegExp(`^/api/hosts/${FP}/reconnect$`), ({ req, res, params }) => {
    if (!gate(req, res)) return;
    if (!c.hostLinks.reconnect(params.fp)) { writeJson(res, 404, { error: "unknown computer" }); return; }
    writeJson(res, 200, c.hostLinks.get(params.fp));
  });
}
