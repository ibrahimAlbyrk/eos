// Device side of peering: the hosts this Mac controls (the Machines menu).
//
// Pairs with a host from an invite, persists it, and keeps one background
// HostLink per paired host — so the Machines menu and All machines view show
// live state for hosts whose window isn't open, and switching to one is instant.

import http2 from "node:http2";
import type { Duplex } from "node:stream";
import { networkInterfaces } from "node:os";

import {
  PairResponseSchema, type HostView, type KnownHost, type LinkRoute, type PairRequest, type RelayGrant, type UpdateHostRequest,
} from "../../contracts/src/peer.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import { formatDeviceId, inviteState } from "../../core/src/domain/peer.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import type { KnownHostStore } from "../../core/src/ports/PeerStore.ts";
import { connectSecure, openPeerSession, PeerIdentityError, type PeerCredentials } from "../../infra/src/peer/secure-channel.ts";
import { parseAddress } from "../../infra/src/peer/machine.ts";
import { safeStringify } from "../../infra/src/util/json.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { HostLink } from "./HostLink.ts";
import { dialFailure, explainDialFailures, type DialFailure } from "./dial-failure.ts";
import { decodeInvite } from "./invite-codec.ts";
import { openRelayPipe, relayJoinBearer, RelayJoinError } from "./relay-pipe.ts";

const PAIR_TIMEOUT_MS = 10_000;
const NETWORK_POLL_MS = 3_000;

export class PairingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PairingError";
    this.status = status;
  }
}

// "Let it control this Mac too", sent with a pairing: this Mac's own ways in.
export interface ReciprocalOffer {
  addrs: string[];
  relay?: RelayGrant;
  // The host took the offer — let it control this Mac.
  accepted: (host: KnownHost) => void;
}

export interface HostLinkServiceDeps {
  creds: PeerCredentials & { fingerprint: string };
  hosts: KnownHostStore;
  // How this Mac introduces itself to a host it pairs with.
  deviceName: () => string;
  // Override for tests; defaults to joining the host's relay room.
  dialRelay?: (target: { url: string; room: string; bearer: string }) => Promise<Duplex> | null;
  // When a host may also control this Mac: where a tunnel offered to it lands
  // (this Mac's peer server). null ⇒ it may not.
  reverseSink?: (hostId: string) => ((pipe: Duplex) => void) | null;
  bus: EventBus;
  now: () => number;
  log: Logger;
}

function networkFingerprint(): string {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => (addrs ?? []).filter((a) => !a.internal).map((a) => a.address))
    .sort()
    .join(",");
}

export class HostLinkService {
  private readonly deps: HostLinkServiceDeps;
  private readonly links = new Map<string, HostLink>();
  private netTimer: ReturnType<typeof setInterval> | null = null;
  private lastNetwork = "";

  constructor(deps: HostLinkServiceDeps) {
    this.deps = deps;
  }

  start(): void {
    for (const h of this.deps.hosts.list()) this.ensureLink(h.id).start();
    this.lastNetwork = networkFingerprint();
    this.netTimer = setInterval(() => {
      const now = networkFingerprint();
      if (now === this.lastNetwork) return;
      this.lastNetwork = now;
      this.deps.log.info("[hosts] network changed — re-probing links", {});
      this.kickAll();
    }, NETWORK_POLL_MS);
    this.netTimer.unref?.();
  }

  stop(): void {
    if (this.netTimer) { clearInterval(this.netTimer); this.netTimer = null; }
    for (const l of this.links.values()) l.stop();
    this.links.clear();
  }

  kickAll(): void {
    for (const l of this.links.values()) l.kick();
  }

  link(id: string): HostLink | null {
    return this.deps.hosts.get(id) ? this.ensureLink(id) : null;
  }

  list(): HostView[] {
    return this.deps.hosts.list().map((h) => this.view(h));
  }

  get(id: string): HostView | null {
    const h = this.deps.hosts.get(id);
    return h ? this.view(h) : null;
  }

  // Redeem an invite: prove the host is who the invite names, hand it the
  // single-use secret, and remember it with whatever relay admission it grants.
  // With a reciprocal offer the host controls this Mac back — one pairing, both ways.
  async pair(inviteLink: string, alias?: string, reciprocal?: ReciprocalOffer): Promise<HostView> {
    let invite;
    try { invite = decodeInvite(inviteLink); } catch (e) { throw new PairingError(400, errMsg(e)); }
    if (inviteState(invite, this.deps.now()) === "expired") throw new PairingError(410, "this invite has expired — make a new one on that Mac");
    if (invite.fp === this.deps.creds.fingerprint) throw new PairingError(400, "that invite is from this Mac");

    const session = await this.openPairingSession(invite);
    // With no invite open the host turns the session away (GOAWAY) instead of
    // answering — the invite was used or cancelled.
    let refused = false;
    session.once("goaway", () => { refused = true; });
    let body: string;
    let status: number;
    try {
      const req: PairRequest = {
        secret: invite.sec,
        name: this.deps.deviceName(),
        platform: process.platform,
        ...(reciprocal ? { reciprocal: { addrs: reciprocal.addrs, relay: reciprocal.relay } } : {}),
      };
      ({ status, body } = await postJson(session, ROUTES.peerPair, req));
    } catch (e) {
      if (refused) throw new PairingError(403, "that Mac isn't taking this invite — it was already used or cancelled; make a new one there");
      throw e;
    } finally {
      session.close();
    }
    if (status !== 200) {
      let message = `pairing failed (${status})`;
      try { message = (JSON.parse(body) as { error?: string }).error ?? message; } catch { /* keep generic */ }
      throw new PairingError(status === 403 ? 403 : 502, message);
    }
    const parsed = PairResponseSchema.safeParse(JSON.parse(body));
    if (!parsed.success) throw new PairingError(502, "that Mac answered with an incompatible Eos version");
    const host = this.remember({
      id: invite.fp,
      name: parsed.data.host.name,
      alias: alias?.trim() || null,
      platform: parsed.data.host.platform,
      addrs: invite.addrs,
      relay: parsed.data.relay,
      lastConnectedAt: this.deps.now(),
    });
    if (reciprocal && parsed.data.reciprocal) reciprocal.accepted(host);
    return this.view(host);
  }

  // A device pairing with this Mac lets this Mac control it too: remember it
  // like a host paired through an invite, and bring its link up.
  adoptReciprocal(d: { fp: string; name: string; platform: string; addrs: string[]; relay?: RelayGrant }): void {
    this.remember({ id: d.fp, name: d.name, alias: null, platform: d.platform, addrs: d.addrs, relay: d.relay, lastConnectedAt: null });
  }

  // Save a paired host (keeping what the person set before) and (re)start its link.
  private remember(h: Omit<KnownHost, "pairedAt">): KnownHost {
    const existing = this.deps.hosts.get(h.id);
    const { relay: given, ...rest } = h;
    const relay = given ?? existing?.relay;
    const host: KnownHost = {
      ...rest,
      alias: h.alias || existing?.alias || null,
      ...(relay ? { relay } : {}),
      pairedAt: existing?.pairedAt ?? this.deps.now(),
      lastConnectedAt: h.lastConnectedAt ?? existing?.lastConnectedAt ?? null,
    };
    this.deps.hosts.upsert(host);
    const link = this.ensureLink(host.id);
    link.stop();
    link.start();
    this.changed(host.id);
    this.deps.log.info("[hosts] paired with host", { host: host.name, deviceId: formatDeviceId(host.id) });
    return host;
  }

  update(id: string, patch: UpdateHostRequest): HostView | null {
    const h = this.deps.hosts.get(id);
    if (!h) return null;
    const next: KnownHost = {
      ...h,
      ...(patch.alias !== undefined ? { alias: patch.alias?.trim() || null } : {}),
      ...(patch.addrs ? { addrs: patch.addrs } : {}),
    };
    this.deps.hosts.upsert(next);
    if (patch.addrs) this.links.get(id)?.kick();
    this.changed(id);
    return this.view(next);
  }

  forget(id: string): boolean {
    const removed = this.deps.hosts.remove(id);
    this.links.get(id)?.stop();
    this.links.delete(id);
    if (removed) this.changed(id);
    return removed;
  }

  // A host this Mac controls opened a tunnel back through its link here: that
  // host's link takes it. null ⇒ this Mac doesn't control that computer.
  reverseFrom(id: string): ((pipe: Duplex) => void) | null {
    const link = this.link(id);
    return link ? (pipe) => link.addReverse(pipe) : null;
  }

  // That host may now control this Mac: offer it a way back through the link.
  offerReverse(id: string): void {
    this.links.get(id)?.offerReverse();
  }

  reconnect(id: string): boolean {
    const link = this.link(id);
    if (!link) return false;
    if (link.status.state === "unauthorized") { link.stop(); link.start(); } else link.kick();
    return true;
  }

  private dialRelayPipe(target: { url: string; room: string; bearer: string }): Promise<Duplex> | null {
    return this.deps.dialRelay ? this.deps.dialRelay(target) : openRelayPipe(target);
  }

  private async openPairingSession(invite: ReturnType<typeof decodeInvite>): Promise<http2.ClientHttp2Session> {
    const tries: Array<Promise<import("node:tls").TLSSocket>> = [];
    const failures: DialFailure[] = [];
    const tracked = (route: LinkRoute, p: Promise<import("node:tls").TLSSocket>) =>
      p.catch((e: unknown) => { failures.push(dialFailure(route, e)); throw e; });
    for (const addr of invite.addrs) {
      const target = parseAddress(addr);
      if (target) tries.push(tracked("direct", connectSecure({ creds: this.deps.creds, expectFingerprint: invite.fp, transport: target, timeoutMs: PAIR_TIMEOUT_MS })));
    }
    // Over the relay the room admits this device, for as long as the invite is
    // open, by a bearer derived from its secret — the secret itself only ever
    // crosses inside TLS.
    if (invite.relay) {
      const relay = invite.relay;
      tries.push(tracked("relay", (async () => {
        const pipe = await this.dialRelayPipe({ url: relay.url, room: relay.room, bearer: relayJoinBearer(invite.sec) });
        if (!pipe) throw new PairingError(502, "relay unavailable");
        return connectSecure({ creds: this.deps.creds, expectFingerprint: invite.fp, transport: pipe, timeoutMs: PAIR_TIMEOUT_MS });
      })()));
    }
    if (tries.length === 0) throw new PairingError(502, "that Mac offers no way in — turn on \"Direct on this network\" or set a relay there");
    try {
      const sock = await Promise.any(tries);
      for (const t of tries) void t.then((s) => { if (s !== sock) s.destroy(); }, () => {});
      const session = openPeerSession(sock);
      session.on("error", () => {});
      return session;
    } catch (e) {
      const errors = e instanceof AggregateError ? e.errors : [e];
      if (errors.some((x) => x instanceof PeerIdentityError)) throw new PairingError(403, "the Mac at that address is not the one that made the invite");
      if (errors.some((x) => x instanceof RelayJoinError && x.code === "BEARER_DENIED")) throw new PairingError(410, "the relay no longer accepts this invite — make a new one on that Mac");
      this.deps.log.warn("[hosts] pairing found no route to that Mac", { host: invite.name, failures });
      throw new PairingError(502, `couldn't reach that Mac: ${explainDialFailures(failures)}`);
    }
  }

  private ensureLink(id: string): HostLink {
    let link = this.links.get(id);
    if (link) return link;
    link = new HostLink({
      creds: this.deps.creds,
      host: () => this.deps.hosts.get(id),
      dialRelay: (h) => (h.relay ? this.dialRelayPipe(h.relay) : null),
      reverseSink: () => this.deps.reverseSink?.(id) ?? null,
      now: this.deps.now,
      log: this.deps.log,
      onChange: () => this.changed(id),
      onNotification: (payload) => {
        const h = this.deps.hosts.get(id);
        const p = (payload ?? {}) as Record<string, unknown>;
        if (!h || typeof p.title !== "string") return;
        // Raised here so this Mac's app shows it; `host` tells the app which
        // computer to switch to when it is clicked.
        this.deps.bus.publish("notification:fire", {
          ...p,
          title: `${h.alias || h.name} · ${p.title}`,
          host: { id: h.id, name: h.alias || h.name },
        });
      },
      onInfo: (info) => {
        const h = this.deps.hosts.get(id);
        if (h && (h.name !== info.name || h.platform !== info.platform || h.lastConnectedAt == null)) {
          this.deps.hosts.upsert({ ...h, name: info.name, platform: info.platform, lastConnectedAt: this.deps.now() });
        } else if (h) {
          this.deps.hosts.upsert({ ...h, lastConnectedAt: this.deps.now() });
        }
      },
    });
    this.links.set(id, link);
    return link;
  }

  private view(h: KnownHost): HostView {
    const { relay, ...rest } = h;
    const link = this.links.get(h.id);
    return {
      ...rest,
      deviceId: formatDeviceId(h.id),
      hasRelay: relay != null,
      link: link?.status ?? { state: "offline", route: null, rttMs: null, since: this.deps.now(), attempt: 0, error: null },
      info: link?.info ?? null,
    };
  }

  private changed(id: string): void {
    this.deps.bus.publish("hosts:change", { id });
  }
}

function postJson(session: http2.ClientHttp2Session, path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = session.request({ ":method": "POST", ":path": path, "content-type": "application/json" });
    let status = 0;
    let data = "";
    const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); reject(new PairingError(504, "that Mac didn't answer")); }, PAIR_TIMEOUT_MS);
    req.on("response", (h) => { status = Number(h[":status"]); });
    req.setEncoding("utf8");
    req.on("data", (d: string) => { data += d; });
    req.on("end", () => { clearTimeout(timer); resolve({ status, body: data }); });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(safeStringify(body));
  });
}
