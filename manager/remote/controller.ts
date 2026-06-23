// Runtime arm/disarm for the remote edge. The daemon used to build the /ws
// gateway + RelayConnector ONCE at boot (gated on config.remote.mode), so any
// change to config.remote only took effect on a restart. This controller makes
// enabling restart-free: it installs ONE persistent "upgrade" listener on the
// daemon's HTTP server and swaps the live gateway underneath it.
//
//   * armed (LAN)   → the persistent listener delegates /ws to the gateway.
//   * armed (relay) → RelayConnector dials out; no LAN /ws surface, so /ws 503s.
//   * disarmed      → /ws is rejected (503) without a restart.
//
// reconcile() is the single entry point (called at boot and on Save/arm): it
// fully tears down the current gateway, then rebuilds for the CURRENT config.
// Always stop-before-start, so re-arming never double-binds and disarming fully
// tears down (relay socket closed ⇒ room deregistered).

import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { startRemoteGateway, type RemoteGatewayHandle, type RemoteWiringDeps } from "./wire.ts";
import type { Router } from "../routes/Router.ts";
import type { RemoteMode } from "../../contracts/src/remote.ts";

export class RemoteController {
  private handle: RemoteGatewayHandle | null = null;

  constructor(
    private readonly c: RemoteWiringDeps,
    private readonly router: Router,
    server: Server,
  ) {
    server.on("upgrade", this.onUpgrade);
  }

  // The single persistent /ws upgrade listener. Reads the live armed state on
  // every request, so accepting/rejecting /ws follows arm/disarm with no restart.
  private onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return; // not ours — leave for any other handler
    const fn = this.handle?.onUpgrade;
    if (!fn) { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); socket.destroy(); return; }
    fn(req, socket, head);
  };

  current(): RemoteGatewayHandle | null { return this.handle; }

  // Tear down any live gateway and rebuild for the current config. Idempotent and
  // safe to call repeatedly: stop-before-start means no double-bind, and a fresh
  // build picks up config.remote changes (mode/relay url+room).
  reconcile(): { mode: RemoteMode; armed: boolean } {
    this.disarm();
    this.handle = startRemoteGateway(this.c, this.router);
    return { mode: this.c.config.remote.mode, armed: this.handle != null };
  }

  disarm(): void {
    try { this.handle?.stop(); } catch { /* already stopping */ }
    this.handle = null;
  }
}
