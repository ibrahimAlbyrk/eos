// Remote-gateway composition for the daemon (relay v3). Arms the outbound relay
// leg ONLY when config.remote.enabled AND config.remote.relay.url is set (default
// disabled ⇒ this is a no-op and nothing remote runs). Relay-only: the daemon
// dials out via RelayConnector and demuxes per-device sessions through the same
// GatewayConnection driver. There is no LAN-direct /ws lane in v3.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { RoomSecrets, sha256Hex } from "./keyring.ts";
import { RemoteAuditLog } from "./audit.ts";
import { generatePairing } from "./qr.ts";
import { makeRouteDispatch } from "./virtual-dispatch.ts";
import { GatewayConnection, type GatewayDeps } from "./gateway.ts";
import { WsBridge } from "./WsBridge.ts";
import { RelayConnector } from "./RelayConnector.ts";
import type { Router } from "../routes/Router.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { RemoteConfig, PairingQr } from "../../contracts/src/remote.ts";

// Structural subset of the daemon container wire.ts needs — keeps this module
// decoupled from the (inferred) Container type.
export interface RemoteWiringDeps {
  config: { remote: RemoteConfig; daemon: { home: string; port: number } };
  uiToken: string;
  bus: EventBus;
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void };
}

export interface PairArmOptions {
  ttlMs?: number; // QR display-window; default 120s
}

export interface RemoteGatewayHandle {
  stop(): void;
  // Mint the §2 QR from the already-armed room + bearer. There is no server-held
  // one-time token in v3 — the bearer IS the join credential.
  armPairing(opts: PairArmOptions): PairingQr;
}

function loadOwnerSecret(remoteDir: string): string {
  const path = join(remoteDir, "relay-owner.secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  return secret;
}

// Build the remote gateway for the CURRENT config and return a runtime handle, or
// null when remote is disabled (the common case) or relay.url is missing. Pure
// build step — it does NOT touch the HTTP server (relay-only; no /ws upgrade).
// Re-callable at runtime (arm/disarm), not only at boot.
export function startRemoteGateway(c: RemoteWiringDeps, router: Router): RemoteGatewayHandle | null {
  if (!c.config.remote.enabled) return null;

  const relayUrl = c.config.remote.relay?.url;
  if (!relayUrl) {
    c.log.warn("remote enabled but relay.url missing — not armed", {});
    return null;
  }

  const remoteDir = join(c.config.daemon.home, "remote");
  mkdirSync(remoteDir, { recursive: true });
  const secrets = new RoomSecrets(remoteDir); // mint/load room.id + bearer.secret (0600)
  const owner = loadOwnerSecret(remoteDir);
  const audit = new RemoteAuditLog(remoteDir);
  const now = (): number => Date.now();
  const room = secrets.room;

  const deps: GatewayDeps = {
    audit, uiToken: c.uiToken, routeDispatch: makeRouteDispatch(router),
    bus: c.bus, room, now,
    log: (m, x) => c.log.info(`[remote] ${m}`, x ?? {}),
  };

  const bridge = new WsBridge({ bus: c.bus, now });
  bridge.start();
  const conns = new Map<string, GatewayConnection>();
  const connector = new RelayConnector({
    url: relayUrl, room, owner,
    // §4.1: on every (re)connect re-register with the FULL allowlist so the relay's
    // admission cache self-heals. In v3 that is exactly [ sha256Hex(bearer) ] — one
    // room-join capability, not a per-device list.
    allow: () => [sha256Hex(secrets.bearer)],
    onJoined: (clientId) => {
      const hex = clientId.toString("hex");
      const conn = new GatewayConnection({
        deps, bridge, clientId, joinAck: false,
        send: (buf) => connector.sendData(buf),
        close: () => { conns.get(hex)?.dispose(); conns.delete(hex); },
      });
      conns.set(hex, conn);
      conn.start();
    },
    onData: (env) => conns.get(env.clientId.toString("hex"))?.onEnvelope(env),
    onError: (code, message) => c.log.warn("relay error", { code, message }),
    now, log: (m, x) => c.log.info(`[relay] ${m}`, x ?? {}),
  });
  connector.start();
  c.log.info("remote gateway armed", { relayUrl, room });
  return {
    stop: () => { connector.stop(); bridge.stop(); for (const conn of conns.values()) conn.dispose(); conns.clear(); },
    // Pairing is just "mint the QR from the armed room + bearer" — no allowlist
    // mutation (the bearer hash is already in the room's allow from register).
    armPairing: (opts) => generatePairing({ relayUrl, room, bearer: secrets.bearer, now: now(), ttlMs: opts.ttlMs }),
  };
}
