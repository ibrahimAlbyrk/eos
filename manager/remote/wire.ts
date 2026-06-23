// Remote-gateway composition for the daemon. Arms the /ws edge ONLY when
// config.remote.mode != off (default off ⇒ this is a no-op and nothing remote
// runs). LAN mode mounts the /ws upgrade on the daemon's listener; relay mode
// dials out via RelayConnector and demuxes per-device sessions through the same
// GatewayConnection driver. Either way the loopback-lock keeps every non-/ws
// REST surface off-box.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";

import { MacIdentity, DeviceKeyring } from "./keyring.ts";
import { TicketStore } from "./tickets.ts";
import { RemoteAuditLog } from "./audit.ts";
import { PairingManager } from "./pairing.ts";
import { makeRouteDispatch } from "./virtual-dispatch.ts";
import { mountWsGateway, GatewayConnection, type GatewayDeps } from "./gateway.ts";
import { WsBridge } from "./WsBridge.ts";
import { RelayConnector } from "./RelayConnector.ts";
import type { Router } from "../routes/Router.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { RemoteConfig } from "../../contracts/src/remote.ts";

// Structural subset of the daemon container wire.ts needs — keeps this module
// decoupled from the (inferred) Container type.
export interface RemoteWiringDeps {
  config: { remote: RemoteConfig; daemon: { home: string; port: number } };
  uiToken: string;
  bus: EventBus;
  log: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void };
}

export interface PairArmOptions {
  lan?: string[];
  lanSpki?: string | null;
  relay?: { url: string; room: string } | null;
  ttlMs?: number; // offer/QR otsExp window; default 120s
}

export interface RemoteGatewayHandle {
  stop(): void;
  pairing: PairingManager;
  // Arm a one-time pairing offer and return the §6 QR payload. In relay mode the
  // pairing-bearer hash is added to the relay allowlist so a NEW (unenrolled)
  // device can join the room for the pairing window.
  armPairing(opts: PairArmOptions): import("../../contracts/src/remote.ts").PairingQr;
}

function loadOwnerSecret(remoteDir: string): string {
  const path = join(remoteDir, "relay-owner.secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const secret = randomBytes(32).toString("base64url");
  writeFileSync(path, secret + "\n", { mode: 0o600 });
  return secret;
}

// Returns null when remote is off (the common case) or relay config is missing.
export function startRemoteGateway(c: RemoteWiringDeps, router: Router, server: Server): RemoteGatewayHandle | null {
  const mode = c.config.remote.mode;
  if (mode === "off") return null;

  const remoteDir = join(c.config.daemon.home, "remote");
  mkdirSync(remoteDir, { recursive: true });
  const identity = new MacIdentity(remoteDir);
  const keyring = new DeviceKeyring(remoteDir);
  const tickets = new TicketStore();
  const audit = new RemoteAuditLog(remoteDir);
  const now = (): number => Date.now();
  const pairing = new PairingManager(identity, now);
  const baseDeps: Omit<GatewayDeps, "room"> = {
    identity, keyring, tickets, audit, uiToken: c.uiToken,
    routeDispatch: makeRouteDispatch(router), bus: c.bus, now, pairing,
    log: (m, x) => c.log.info(`[remote] ${m}`, x ?? {}),
  };

  if (mode === "lan") {
    const handle = mountWsGateway(server, { ...baseDeps, room: "lan" });
    c.log.info("remote gateway armed", { mode, surface: "/ws" });
    // LAN: the /ws upgrade admits the pairing bearer directly (gateway
    // bearerAdmitted reads pairing.pairingBearerHash()), so arming is just the
    // offer — no relay allowlist to update.
    return { stop: handle.stop, pairing, armPairing: (opts) => pairing.arm(opts) };
  }

  // relay
  const relayUrl = c.config.remote.relay?.url;
  const room = c.config.remote.relay?.room;
  if (!relayUrl || !room) {
    c.log.warn("remote relay mode set but relay.url/room missing — not armed", {});
    return null;
  }
  const owner = loadOwnerSecret(remoteDir);
  const deps: GatewayDeps = { ...baseDeps, room };
  const bridge = new WsBridge({ bus: c.bus, now });
  bridge.start();
  const conns = new Map<string, GatewayConnection>();
  const connector = new RelayConnector({
    url: relayUrl, room, owner,
    // Include the armed pairing bearer so a reconnect's re-register (which resends
    // the whole allowlist) doesn't drop the in-flight pairing offer — otherwise a
    // dropped relay socket mid-pairing would BEARER_DENY the joining device.
    allow: () => {
      const hashes = keyring.bearerHashAllowlist();
      const pair = pairing.pairingBearerHash();
      return pair ? [...hashes, pair] : hashes;
    },
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
  c.log.info("remote gateway armed", { mode, relayUrl, room });
  return {
    stop: () => { connector.stop(); bridge.stop(); for (const conn of conns.values()) conn.dispose(); conns.clear(); },
    pairing,
    armPairing: (opts) => {
      const qr = pairing.arm(opts);
      // Relay admits on the bearer-hash allowlist — add the one-time pairing
      // bearer so an unenrolled device can join the room to pair. The durable
      // bearer is swapped in (and the pairing hash dropped) after enrollment.
      const hash = pairing.pairingBearerHash();
      if (hash) connector.allowAdd(hash);
      return qr;
    },
  };
}
