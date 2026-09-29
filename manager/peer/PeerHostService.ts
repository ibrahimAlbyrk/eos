// Hosting: lets paired computers control THIS Mac (Settings › Remote access).
//
// Owns the secure peer server (direct listener + relay-fed connections), the
// single-use invites, pairing, and the paired-device list. Every trusted stream
// is handed to the gateway, which replays it against this daemon's own local
// endpoints; nothing here knows about workers, files or terminals.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http2 from "node:http2";
import type { Duplex } from "node:stream";
import { homedir } from "node:os";

import { ROUTES } from "../../contracts/src/http.ts";
import {
  PairRequestSchema, PEER_REFUSAL,
  type HostInfo, type InviteResponse, type PairResponse, type PairedDevice, type PairedDeviceView, type PeerConfig, type PeerStatus,
} from "../../contracts/src/peer.ts";
import { admitPeer, formatDeviceId } from "../../core/src/domain/peer.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import type { OpenInviteStore, PairedDeviceStore } from "../../core/src/ports/PeerStore.ts";
import { createSecurePeerServer, type PeerSessionInfo, type SecurePeerServer } from "../../infra/src/peer/secure-channel.ts";
import { computerName, directAddresses, parseAddress } from "../../infra/src/peer/machine.ts";
import type { PeerIdentityMaterial } from "../../infra/src/peer/x509.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { createLocalForwarder, respondJson, type LocalDaemonTarget } from "./gateway.ts";
import { encodeInvite } from "./invite-codec.ts";
import { PeerRelayHost, bearerHash, relayJoinBearer, type RelayPipe } from "./relay-pipe.ts";
import { startKeepAwake } from "../remote/keepAwake.ts";

// Invites never expire on their own (one may be redeemed a day later, from
// another network) — so only a few may be open at once, each works once, and
// wrong guesses burn them all.
const MAX_OPEN_INVITES = 3;
// Wrong secrets tolerated before every open invite is burned.
const MAX_PAIR_FAILURES = 5;
const MAX_PAIR_BODY_BYTES = 16 * 1024;

// The route surface a UI bundle expects. Two daemons with the same stamp speak
// the same HTTP API; a controlling UI uses it to decide whose bundle to load.
export function computeApiStamp(): string {
  const surface = Object.entries(ROUTES).map(([k, v]) => `${k}=${typeof v === "function" ? v(":id") : v}`).sort();
  return createHash("sha256").update(surface.join("\n")).digest("hex").slice(0, 16);
}

// This Mac's peering room on a relay — the room id and owner secret are
// persisted; the URL comes from config.
export interface RelayRoom {
  url: string;
  room: string;
  owner: string;
}

export interface PeerHostDeps {
  identity: PeerIdentityMaterial;
  devices: PairedDeviceStore;
  // Open invites survive a restart; only their hashes are kept.
  invites: OpenInviteStore;
  getConfig: () => PeerConfig;
  target: LocalDaemonTarget;
  servesUi: () => boolean;
  // The relay this Mac is reachable through when direct paths fail; null ⇒ none.
  relayRoom: () => RelayRoom | null;
  // Injectable for tests; defaults to a real PeerRelayHost.
  createRelayHost?: (args: ConstructorParameters<typeof PeerRelayHost>[0]) => Pick<PeerRelayHost, "start" | "stop" | "online" | "refreshAllow" | "url" | "room">;
  bus: EventBus;
  now: () => number;
  log: Logger;
  // Where devices can reach the bound port directly; defaults to this Mac's
  // LAN/tailnet interfaces.
  addresses?: (port: number) => string[];
  // Holds system sleep off while hosting (a sleeping Mac can't be reached);
  // returns the release. Defaults to caffeinate, as for the iPhone edge.
  keepAwake?: () => () => void;
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function readJsonBody(stream: http2.ServerHttp2Stream, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); stream.close(); return; }
      chunks.push(c);
    });
    stream.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("body is not JSON")); }
    });
    stream.on("error", reject);
  });
}

export class PeerHostService {
  private readonly deps: PeerHostDeps;
  private readonly server: SecurePeerServer;
  private readonly forwarder: ReturnType<typeof createLocalForwarder>;
  private readonly apiStamp = computeApiStamp();
  private readonly machineName = computerName();
  // sha256(secret) hex → the hash of its relay join bearer. Insertion order = age.
  private readonly invites = new Map<string, string>();
  private relayHost: ReturnType<NonNullable<PeerHostDeps["createRelayHost"]>> | null = null;
  private releaseKeepAwake: (() => void) | null = null;
  private pairFailures = 0;
  // The configured port currently served, and the port actually bound (they
  // differ when the config asks for an ephemeral port).
  private listeningPort: number | null = null;
  private boundPort: number | null = null;
  private reconciling: Promise<void> = Promise.resolve();

  constructor(deps: PeerHostDeps) {
    this.deps = deps;
    for (const inv of [...deps.invites.list()].sort((a, b) => a.createdAt - b.createdAt)) this.invites.set(inv.hash, inv.joinHash);
    this.forwarder = createLocalForwarder(deps.target);
    this.server = createSecurePeerServer({
      creds: deps.identity,
      admit: (fingerprint) => {
        if (!this.deps.getConfig().enabled) return { admission: "refused", reason: PEER_REFUSAL.hostingOff };
        const admission = admitPeer({ fingerprint, trusted: this.trustedSet(), pairingOpen: this.pairingOpen() });
        return admission === "refused" ? { admission, reason: PEER_REFUSAL.notPaired } : { admission };
      },
      onStream: (stream, headers, peer) => this.onStream(stream, headers, peer),
      onSession: (peer, event) => this.onSession(peer, event),
      log: (m, x) => deps.log.info(`[peer] ${m}`, x ?? {}),
    });
  }

  hostInfo(): HostInfo {
    const fp = this.deps.identity.fingerprint;
    return {
      id: fp,
      deviceId: formatDeviceId(fp),
      name: this.deps.getConfig().name ?? this.machineName,
      platform: process.platform,
      home: homedir(),
      apiStamp: this.apiStamp,
      servesUi: this.deps.servesUi(),
    };
  }

  status(): PeerStatus {
    const cfg = this.deps.getConfig();
    return {
      enabled: cfg.enabled,
      direct: cfg.direct,
      port: cfg.port,
      listening: this.server.listening,
      host: this.hostInfo(),
      addrs: this.currentAddresses(),
      relay: this.relayHost ? { url: this.relayHost.url, online: this.relayHost.online() } : null,
      openInvites: this.invites.size,
      devices: this.devicesView(),
    };
  }

  devicesView(): PairedDeviceView[] {
    const connected = new Set(this.server.connected());
    return this.deps.devices.list().map(({ relayBearerHash: _, ...d }) => ({
      ...d,
      deviceId: formatDeviceId(d.fp),
      connected: connected.has(d.fp),
    }));
  }

  createInvite(): InviteResponse {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) throw new Error("remote access is off");
    while (this.invites.size >= MAX_OPEN_INVITES) this.dropInvite(this.invites.keys().next().value as string);
    const secret = randomBytes(18).toString("base64url");
    const hash = sha256(secret).toString("hex");
    const joinHash = bearerHash(relayJoinBearer(secret));
    this.invites.set(hash, joinHash);
    this.deps.invites.upsert({ hash, joinHash, createdAt: this.deps.now() });
    this.pairFailures = 0;
    this.relayHost?.refreshAllow();
    const relay = this.relayHost;
    const info = this.hostInfo();
    const link = encodeInvite({
      v: 1,
      fp: info.id,
      sec: secret,
      name: info.name,
      addrs: this.currentAddresses(),
      ...(relay ? { relay: { url: relay.url, room: relay.room } } : {}),
    });
    return { link, deviceId: info.deviceId };
  }

  // Every open invite stops working — a link that went somewhere it shouldn't.
  cancelInvites(): number {
    const n = this.invites.size;
    for (const hash of [...this.invites.keys()]) this.dropInvite(hash);
    if (n) this.relayHost?.refreshAllow();
    return n;
  }

  revoke(fp: string): boolean {
    const device = this.deps.devices.get(fp);
    if (!device) return false;
    this.deps.devices.remove(fp);
    this.relayHost?.refreshAllow();
    this.server.disconnect(fp);
    this.publishPresence();
    this.deps.log.info("[peer] device revoked", { deviceId: formatDeviceId(fp) });
    return true;
  }

  disconnect(fp: string): number {
    return this.server.disconnect(fp);
  }

  // A relay-carried connection enters the same TLS server as a direct one.
  acceptRelayed(transport: Duplex): void {
    this.server.accept(transport);
  }

  // Who the relay may admit into this Mac's room: paired devices by their own
  // bearer, and — only while an invite is open — a device redeeming it.
  relayAllow(): string[] {
    return [
      ...this.deps.devices.list().flatMap((d) => (d.relayBearerHash ? [d.relayBearerHash] : [])),
      ...this.invites.values(),
    ];
  }

  // Apply config.peer: listen when hosting + direct are on, drop everything when
  // hosting is off. Serialized so rapid toggles can't interleave binds.
  reconcile(): Promise<void> {
    this.reconciling = this.reconciling
      .then(() => this.applyConfig())
      .catch((e) => this.deps.log.warn("[peer] reconcile failed", { error: errMsg(e) }));
    return this.reconciling;
  }

  async stop(): Promise<void> {
    this.releaseKeepAwake?.();
    this.releaseKeepAwake = null;
    this.relayHost?.stop();
    this.relayHost = null;
    await this.server.close();
    this.forwarder.close();
  }

  private async applyConfig(): Promise<void> {
    const cfg = this.deps.getConfig();
    if (!cfg.enabled) {
      for (const hash of [...this.invites.keys()]) this.dropInvite(hash);
      this.server.disconnectAll();
    }
    this.applyRelay(cfg.enabled ? this.deps.relayRoom() : null);
    if (cfg.enabled && !this.releaseKeepAwake) {
      this.releaseKeepAwake = (this.deps.keepAwake ?? (() => startKeepAwake({ log: (m, x) => this.deps.log.info(`[peer] ${m}`, x ?? {}) })))();
    } else if (!cfg.enabled && this.releaseKeepAwake) {
      this.releaseKeepAwake();
      this.releaseKeepAwake = null;
    }
    const wantPort = cfg.enabled && cfg.direct ? cfg.port : null;
    if (this.server.listening && this.listeningPort === wantPort) return;
    if (this.server.listening) await this.server.unlisten();
    this.listeningPort = null;
    this.boundPort = null;
    if (wantPort == null) return;
    try {
      const addr = await this.server.listen(wantPort);
      this.listeningPort = wantPort;
      this.boundPort = addr.port;
      this.deps.log.info("[peer] listening for paired devices", { port: addr.port });
    } catch (e) {
      this.deps.log.warn("[peer] direct listener failed — relay only", { port: wantPort, error: errMsg(e) });
    }
  }

  // One relay leg while hosting is on and a relay is configured; a changed URL
  // or room rebuilds it.
  private applyRelay(room: RelayRoom | null): void {
    const current = this.relayHost;
    if (current && room && current.url === room.url && current.room === room.room) return;
    current?.stop();
    this.relayHost = null;
    if (!room) return;
    const create = this.deps.createRelayHost ?? ((a) => new PeerRelayHost(a));
    this.relayHost = create({
      url: room.url,
      room: room.room,
      owner: room.owner,
      allow: () => this.relayAllow(),
      onPipe: (pipe: RelayPipe) => this.acceptRelayed(pipe),
      log: this.deps.log,
    });
    this.relayHost.start();
    this.deps.log.info("[peer] reachable through relay", { url: room.url });
  }

  private currentAddresses(): string[] {
    if (!this.server.listening || this.boundPort == null) return [];
    const port = this.boundPort;
    const advertised = (this.deps.getConfig().advertise ?? []).map((a) => (parseAddress(a) ? a : `${a}:${port}`));
    return [...new Set([...advertised, ...(this.deps.addresses ?? directAddresses)(port)])];
  }

  private trustedSet(): Set<string> {
    return new Set(this.deps.devices.list().map((d) => d.fp));
  }

  private dropInvite(hash: string): void {
    this.invites.delete(hash);
    this.deps.invites.remove(hash);
  }

  private pairingOpen(): boolean {
    return this.invites.size > 0;
  }

  private redeem(secret: string): boolean {
    const presented = sha256(secret);
    for (const hash of this.invites.keys()) {
      if (timingSafeEqual(presented, Buffer.from(hash, "hex"))) {
        this.dropInvite(hash);
        this.relayHost?.refreshAllow();
        return true;
      }
    }
    return false;
  }

  private onStream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, peer: PeerSessionInfo): void {
    if (headers[":path"] === ROUTES.peerPair && headers[":method"] === "POST") {
      void this.pair(stream, peer);
      return;
    }
    // Trust is re-read per stream: a revoked device's in-flight session gets
    // nothing more even before its teardown lands.
    if (!this.deps.getConfig().enabled || !this.deps.devices.get(peer.fingerprint)) {
      respondJson(stream, 403, { error: "this device is not paired" });
      return;
    }
    this.forwarder.forward(stream, headers, peer.fingerprint);
  }

  private async pair(stream: http2.ServerHttp2Stream, peer: PeerSessionInfo): Promise<void> {
    let body: unknown;
    try { body = await readJsonBody(stream, MAX_PAIR_BODY_BYTES); } catch (e) { respondJson(stream, 400, { error: errMsg(e) }); return; }
    const parsed = PairRequestSchema.safeParse(body);
    if (!parsed.success) { respondJson(stream, 400, { error: "invalid pair request" }); return; }
    if (!this.redeem(parsed.data.secret)) {
      if (++this.pairFailures >= MAX_PAIR_FAILURES) {
        this.cancelInvites();
        this.deps.log.warn("[peer] too many failed pairing attempts — open invites burned", {});
      }
      respondJson(stream, 403, { error: "invite is invalid, already used or cancelled — make a new one on that Mac" });
      return;
    }
    const now = this.deps.now();
    const existing = this.deps.devices.get(peer.fingerprint);
    // Every paired device gets its own relay bearer, so revoking one device
    // closes the relay to it alone.
    const relay = this.relayHost;
    let relayGrant: PairResponse["relay"];
    let relayBearerHash = existing?.relayBearerHash;
    if (relay) {
      const bearer = randomBytes(32).toString("base64url");
      relayBearerHash = bearerHash(bearer);
      relayGrant = { url: relay.url, room: relay.room, bearer };
    }
    const device: PairedDevice = {
      fp: peer.fingerprint,
      name: parsed.data.name,
      platform: parsed.data.platform,
      pairedAt: existing?.pairedAt ?? now,
      lastSeenAt: now,
      ...(relayBearerHash ? { relayBearerHash } : {}),
    };
    this.deps.devices.upsert(device);
    this.relayHost?.refreshAllow();
    this.deps.log.info("[peer] device paired", { deviceId: formatDeviceId(peer.fingerprint), name: device.name });
    const response: PairResponse = { host: this.hostInfo(), ...(relayGrant ? { relay: relayGrant } : {}) };
    respondJson(stream, 200, response);
    this.publishPresence();
  }

  private onSession(peer: PeerSessionInfo, event: "open" | "close"): void {
    const device = this.deps.devices.get(peer.fingerprint);
    if (!device) return;
    this.deps.devices.upsert({ ...device, lastSeenAt: this.deps.now() });
    this.deps.log.info(`[peer] device ${event === "open" ? "connected" : "disconnected"}`, { deviceId: formatDeviceId(peer.fingerprint) });
    this.publishPresence();
  }

  private publishPresence(): void {
    const connected = new Set(this.server.connected());
    const devices = this.deps.devices.list()
      .filter((d) => connected.has(d.fp))
      .map((d) => ({ fp: d.fp, name: d.name, deviceId: formatDeviceId(d.fp) }));
    this.deps.bus.publish("peer:presence", { devices });
  }
}
