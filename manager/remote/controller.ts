// Runtime arm/disarm for the remote edge (relay v3). In relay-only mode there is
// no LAN /ws surface to install on the HTTP server — arming just dials out via
// RelayConnector, disarming closes that socket (which deregisters the room). This
// controller makes enabling restart-free: reconcile() fully tears down the current
// gateway, then rebuilds for the CURRENT config.
//
// Always stop-before-start, so re-arming never double-dials and disarming fully
// tears down (relay socket closed ⇒ room deregistered).

import { startRemoteGateway, type RemoteGatewayHandle, type RemoteWiringDeps } from "./wire.ts";
import type { Router } from "../routes/Router.ts";

export class RemoteController {
  private handle: RemoteGatewayHandle | null = null;
  private readonly c: RemoteWiringDeps;
  private readonly router: Router;

  constructor(c: RemoteWiringDeps, router: Router) {
    this.c = c;
    this.router = router;
  }

  current(): RemoteGatewayHandle | null { return this.handle; }

  // Tear down any live gateway and rebuild for the current config. Idempotent and
  // safe to call repeatedly: stop-before-start means no double-dial, and a fresh
  // build picks up config.remote changes (enabled + relay.url).
  reconcile(): { enabled: boolean; armed: boolean } {
    this.disarm();
    this.handle = startRemoteGateway(this.c, this.router);
    return { enabled: this.c.config.remote.enabled, armed: this.handle != null };
  }

  disarm(): void {
    try { this.handle?.stop(); } catch { /* already stopping */ }
    this.handle = null;
  }
}
