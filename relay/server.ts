import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { loadConfig, type RelayConfig } from "./config.ts";
import { RoomRegistry, type RelaySocket } from "./RoomRegistry.ts";
import {
  parseEnvelope,
  encodeJsonEnvelope,
  FrameType,
  Dir,
  MAX_ENVELOPE_BYTES,
} from "./envelope.ts";
import { errorPayload, RelayError, type RelayErrorCode } from "./errors.ts";
import { sendPushIntent, type PushIntent } from "./apns.ts";
import { VaultStore } from "./vault/VaultStore.ts";
import { handleVault, type VaultWaiters } from "./vault/routes.ts";

// The dumb unicast forwarder (protocol §4). A single plain-ws listener fronted by
// Caddy (which owns TLS/ACME). The relay parses only the outer header and the
// relay-control JSON; `data` payloads are opaque application bytes forwarded
// verbatim (plaintext inner-frame JSON since v3 — the relay never inspects them).

function asBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

function parseJson(payload: Buffer): Record<string, unknown> | null {
  try {
    const v = JSON.parse(payload.toString("utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function sendError(ws: WebSocket, room: string, code: RelayErrorCode, message: string): void {
  ws.send(encodeJsonEnvelope({ type: FrameType.error, room, json: errorPayload(code, message) }));
}

// join-ack / Mac-notify (§5.3, "clientId encoding LOCKED"). The clientId travels two
// ways and MUST be byte-identical for both ends: as b64u (unpadded base64url of the 16
// raw bytes, 22 chars) in the JSON body — the load-bearing copy both ends decode — and
// stamped in the outer-header clientId field so the device can cross-check header==body.
function notifyJoined(target: RelaySocket, room: string, clientId: Buffer): void {
  notify(target, room, { t: "joined", clientId: clientId.toString("base64url"), room }, clientId);
}

// Relay-control notice to one peer (clientId zero unless it names a device).
function notify(target: RelaySocket, room: string, json: Record<string, unknown>, clientId?: Buffer): void {
  target.send(encodeJsonEnvelope({ type: FrameType.relayctl, room, dir: Dir.s2c, clientId, json }));
}

function handleMessage(ws: WebSocket, raw: Buffer, registry: RoomRegistry): void {
  if (raw.length > MAX_ENVELOPE_BYTES) {
    sendError(ws, "", RelayError.FRAME_TOO_LARGE, "envelope exceeds 5 MiB");
    return;
  }
  let env;
  try {
    env = parseEnvelope(raw);
  } catch {
    return; // malformed header — drop silently
  }

  switch (env.type) {
    case FrameType.data: {
      const res = registry.routeData(env.room, env.dir, env.clientId.toString("hex"), raw);
      if (!res.ok) sendError(ws, env.room, res.code, "no route for frame");
      return;
    }
    case FrameType.register: {
      const j = parseJson(env.payload);
      const room = str(j?.room) ?? env.room;
      const owner = str(j?.owner);
      const allow = Array.isArray(j?.allow) ? (j!.allow as unknown[]).filter((x): x is string => typeof x === "string") : [];
      if (!j || !owner || !room) {
        sendError(ws, room ?? "", RelayError.BAD_REQUEST, "register needs room + owner");
        return;
      }
      const res = registry.register(room, owner, allow, ws);
      if (!res.ok) sendError(ws, room, res.code, "register rejected");
      else notify(ws, room, { t: "registered", room });
      return;
    }
    case FrameType.join: {
      const j = parseJson(env.payload);
      const room = str(j?.room) ?? env.room;
      const bearer = str(j?.bearer);
      const apnsToken = str(j?.apnsToken);
      // A silent drop here would leave the device waiting on a join-ack forever.
      if (!j || !bearer || !room) {
        sendError(ws, room ?? "", RelayError.BAD_REQUEST, "join needs room + bearer");
        return;
      }
      const res = registry.join(room, bearer, ws, apnsToken);
      if (!res.ok) {
        sendError(ws, room, res.code, "join rejected");
        return;
      }
      // §4.2 mandates BOTH deliveries: notify the Mac so it spins up the per-client
      // session, and ack the joining device so it learns the clientId it must stamp
      // on every outgoing frame. The device MUST NOT send a data frame before this
      // join-ack arrives (there is no handshake in v3 — join-ack ⇒ live).
      notifyJoined(res.mac, room, res.clientId);
      notifyJoined(ws, room, res.clientId);
      return;
    }
    case FrameType.relayctl: {
      const j = parseJson(env.payload);
      const room = str(j?.room) ?? env.room;
      const t = str(j?.t);
      if (!j || !t || !room) return;
      if (t === "allow-add" || t === "allow-remove") {
        const hash = str(j.hash);
        if (!hash) return;
        const res = registry.updateAllow(room, t === "allow-add" ? "add" : "remove", hash, ws);
        if (!res.ok) sendError(ws, room, res.code, "allowlist update rejected");
      } else if (t === "pushIntent") {
        // Opt-in APNs egress — no-op stub unless the operator configured their own
        // APNs key + bundle-id (apns.ts). pushIntent framing is provisional.
        const intent = j as PushIntent;
        for (const token of registry.deviceTokens(room)) sendPushIntent(token, intent);
      }
      return;
    }
    case FrameType.ka:
      return; // app-level keepalive: tolerated, neither forwarded nor answered
    default:
      return;
  }
}

export function createRelay(config: RelayConfig): { httpServer: Server; wss: WebSocketServer; registry: RoomRegistry; vault: VaultStore } {
  const registry = new RoomRegistry({ ownerHashPin: config.ownerHashPin, maxRoomDevices: config.maxRoomDevices });
  const vault = new VaultStore(config.vaultPath, { maxVaults: config.maxVaults, maxVaultBytes: config.maxVaultBytes });
  const waiters: VaultWaiters = new Map();
  const httpServer = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: registry.roomCount() }));
      return;
    }
    if (handleVault(req, res, vault, waiters, config)) return;
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("Upgrade Required");
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_ENVELOPE_BYTES + 1024 });
  // Sockets that answered the last ping. TCP alone never notices a half-open peer
  // (suspended phone, sleeping Mac, expired NAT) — without this the room keeps
  // routing into the void and the other side looks connected but gets nothing.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      ws.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref?.();
  wss.on("close", () => clearInterval(heartbeat));
  httpServer.on("close", () => vault.close());
  wss.on("connection", (ws) => {
    ws.binaryType = "nodebuffer";
    alive.add(ws);
    ws.on("pong", () => alive.add(ws));
    ws.on("message", (data) => {
      const buf = asBuffer(data);
      if (buf) handleMessage(ws, buf, registry);
    });
    ws.on("close", () => {
      const dropped = registry.drop(ws);
      if (dropped?.role === "device" && dropped.mac) {
        notify(dropped.mac, dropped.room, { t: "left", clientId: dropped.clientId.toString("base64url"), room: dropped.room }, dropped.clientId);
      }
    });
    ws.on("error", () => {});
  });
  return { httpServer, wss, registry, vault };
}

function isEntrypoint(): boolean {
  return Boolean(process.argv[1] && import.meta.url === `file://${process.argv[1]}`);
}

if (isEntrypoint()) {
  const config = loadConfig();
  const { httpServer } = createRelay(config);
  httpServer.listen(config.port, config.host, () => {
    console.log(`eos-relay listening on ${config.host}:${config.port}`);
  });
}
