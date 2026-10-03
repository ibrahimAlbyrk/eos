// Device side of one peer link: keeps an HTTP/2 session to a controlled host
// alive and tells the rest of the daemon how that link is doing.
//
// Connecting races every route the host might be on (its LAN/tailnet addresses,
// a tunnel the host opened back to this Mac, then the relay) and keeps the first
// one that proves the pinned identity.
// Liveness is an HTTP/2 PING — it doubles as the latency the UI shows. A host
// that refuses this device (revoked, remote access switched off) says so in its
// GOAWAY, and the link stops retrying instead of looping as if offline.

import http2 from "node:http2";
import type tls from "node:tls";
import type { Duplex } from "node:stream";

import { PEER_REFUSAL, type HostInfo, type KnownHost, type LinkRoute, type LinkStatus } from "../../contracts/src/peer.ts";
import { HostInfoSchema } from "../../contracts/src/peer.ts";
import { ROUTES } from "../../contracts/src/http.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import { connectSecure, openPeerSession, PeerIdentityError, type PeerCredentials } from "../../infra/src/peer/secure-channel.ts";
import { parseAddress } from "../../infra/src/peer/machine.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { blockedFromLocalNetwork, dialFailure, explainDialFailures, type DialFailure } from "./dial-failure.ts";

// Error codes surfaced in LinkStatus.error — the UI maps them to copy.
export const LINK_ERROR = {
  identityChanged: "identity-changed",
  notPaired: PEER_REFUSAL.notPaired,
  hostingOff: PEER_REFUSAL.hostingOff,
  noRoute: "no-route",
  unreachable: "unreachable",
  // A direct path failed with "no route to host" — most often macOS Local
  // Network privacy keeping Eos off the LAN.
  localNetwork: "local-network",
} as const;

const DIAL_TIMEOUT_MS = 6_000;
// Direct candidates start this far apart; the relay joins after them so a
// reachable LAN address wins without waiting for the relay handshake.
const STAGGER_MS = 150;
// A tunnel from the host rides a link that is already up — tried before the relay.
const REVERSE_DELAY_MS = 200;
const RELAY_DELAY_MS = 400;
// A tunnel this Mac offered was used up or dropped: offer the next after this.
const REOFFER_MS = 1_000;
const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 6_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
// Remote access switched off on the host: check back now and then, not in a loop.
const HOSTING_OFF_RETRY_MS = 30_000;
// Off a direct path, look for one this often (and on every network change).
const UPGRADE_INTERVAL_MS = 30_000;
const FIRST_UPGRADE_MS = 3_000;
// A replaced session gets this long to finish in-flight requests.
const DRAIN_MS = 5_000;

export interface HostLinkDeps {
  creds: PeerCredentials;
  host: () => KnownHost | null;
  // Opens a byte pipe to the host through its relay room (null ⇒ no relay).
  dialRelay?: (host: KnownHost) => Promise<Duplex> | null;
  now: () => number;
  log: Logger;
  onChange: () => void;
  onInfo?: (info: HostInfo) => void;
  // The host's own notifications (an agent finished, one needs you) — raised on
  // this Mac so they reach the person even when that host's window is closed.
  onNotification?: (payload: unknown) => void;
  // When the host may also control this Mac: where a tunnel this Mac offers it
  // lands (this Mac's peer server). null ⇒ offer none.
  reverseSink?: () => ((pipe: Duplex) => void) | null;
  pingIntervalMs?: number;
}

export class LinkUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LinkUnavailableError";
    this.code = code;
  }
}

interface Waiter {
  resolve: (s: http2.ClientHttp2Session) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostLink {
  private readonly deps: HostLinkDeps;
  private state: LinkStatus;
  private hostInfo: HostInfo | null = null;
  private session: http2.ClientHttp2Session | null = null;
  private dialing = false;
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private upgradeTimer: ReturnType<typeof setInterval> | null = null;
  private upgrading = false;
  private waiters: Waiter[] = [];
  private lastFailure: string | null = null;
  // The route the last live session ran on.
  private lastRoute: LinkRoute | null = null;
  // A tunnel the host opened back to this Mac, kept ready as a way in.
  private reverse: Duplex | null = null;
  // The tunnel this Mac offered the host through the live session.
  private offered: http2.ClientHttp2Stream | null = null;

  constructor(deps: HostLinkDeps) {
    this.deps = deps;
    this.state = { state: "offline", route: null, rttMs: null, since: deps.now(), attempt: 0, error: null };
  }

  get status(): LinkStatus { return this.state; }
  get info(): HostInfo | null { return this.hostInfo; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.session;
    this.session = null;
    s?.destroy();
    this.reverse?.destroy();
    this.reverse = null;
    this.offered = null;
    this.rejectWaiters(new LinkUnavailableError(LINK_ERROR.unreachable, "link stopped"));
    this.setStatus({ state: "offline", route: null, rttMs: null, error: null, attempt: 0 });
  }

  // Something changed that may have broken or healed the path (network switch,
  // wake from sleep, the user pressing Reconnect): probe now instead of waiting.
  kick(): void {
    if (this.stopped) return;
    if (this.session) {
      this.ping();
      if (this.state.route !== "direct") void this.tryUpgrade();
      return;
    }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.state = { ...this.state, attempt: 0 };
    void this.connect();
  }

  // A live session, waiting up to `timeoutMs` for one. Rejects at once when the
  // host has refused this device — a request would never succeed.
  ready(timeoutMs: number): Promise<http2.ClientHttp2Session> {
    if (this.session && !this.session.closed && !this.session.destroyed) return Promise.resolve(this.session);
    if (this.state.state === "unauthorized" || this.stopped) {
      return Promise.reject(new LinkUnavailableError(this.state.error ?? LINK_ERROR.unreachable, "host refused this device"));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve, reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new LinkUnavailableError(this.state.error ?? LINK_ERROR.unreachable, "host is not reachable right now"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
      if (!this.dialing && !this.retryTimer) void this.connect();
    });
  }

  // The host opened a tunnel back to this Mac inside its own link here — the
  // way in when this Mac has no path of its own (no route into the host's
  // network, Local Network privacy, the relay out of reach).
  addReverse(pipe: Duplex): void {
    if (this.stopped) { pipe.destroy(); return; }
    this.reverse?.destroy();
    this.reverse = pipe;
    pipe.once("close", () => { if (this.reverse === pipe) this.reverse = null; });
    if (!this.session && !this.dialing) this.kick();
  }

  // The host may also control this Mac: hand it a tunnel back through this
  // session, so it reaches this Mac even when it has no path of its own. Never
  // through a session that itself rides such a tunnel.
  offerReverse(): void {
    const session = this.session;
    if (!session || session.destroyed || this.offered || this.state.route === "reverse") return;
    const sink = this.deps.reverseSink?.();
    if (!sink) return;
    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request({ ":method": "POST", ":path": ROUTES.peerReverse });
    } catch {
      return;
    }
    this.offered = stream;
    let taken = false;
    stream.on("error", () => {});
    stream.once("response", (h) => {
      if (Number(h[":status"]) !== 200) { stream.close(); return; }
      taken = true;
      sink(stream);
    });
    stream.once("close", () => {
      if (this.offered === stream) this.offered = null;
      // Used or dropped: offer the next while this session lives. A host that
      // declined is asked again only when trust changes (offerReverse again).
      if (!taken || this.session !== session || session.destroyed) return;
      setTimeout(() => this.offerReverse(), REOFFER_MS).unref?.();
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.dialing || this.session) return;
    const host = this.deps.host();
    if (!host) { this.stop(); return; }
    this.dialing = true;
    const attempt = this.state.attempt + 1;
    this.setStatus({ state: this.state.state === "live" || attempt > 1 ? "reconnecting" : "connecting", attempt });
    try {
      const { sock, route } = await this.dial(host);
      if (this.stopped) { sock.destroy(); return; }
      this.adopt(openPeerSession(sock), route);
    } catch (e) {
      if (e instanceof PeerIdentityError) {
        this.refuse(LINK_ERROR.identityChanged);
      } else if (e instanceof LinkUnavailableError && e.code === LINK_ERROR.notPaired) {
        this.refuse(LINK_ERROR.notPaired);
      } else {
        const code = e instanceof LinkUnavailableError ? e.code : LINK_ERROR.unreachable;
        // Retries repeat the same failure; say why once, and again when it changes.
        const why = errMsg(e);
        if (why !== this.lastFailure) {
          this.lastFailure = why;
          this.deps.log.warn("[hosts] no route to host", { host: host.name, why });
        }
        this.setStatus({ state: "reconnecting", route: null, rttMs: null, error: code });
        // A tunnel from the host arrived while this dial ran: use it now.
        this.scheduleRetry(this.reverse ? 0 : undefined);
      }
    } finally {
      this.dialing = false;
    }
  }

  private dial(host: KnownHost): Promise<{ sock: tls.TLSSocket; route: LinkRoute }> {
    const attempts: Array<{ delay: number; route: LinkRoute; open: () => Promise<tls.TLSSocket> }> = [];
    host.addrs.forEach((addr, i) => {
      const target = parseAddress(addr);
      if (!target) return;
      attempts.push({
        delay: i * STAGGER_MS, route: "direct",
        open: () => connectSecure({ creds: this.deps.creds, expectFingerprint: host.id, transport: target, timeoutMs: DIAL_TIMEOUT_MS }),
      });
    });
    if (this.reverse) {
      attempts.push({
        delay: attempts.length ? REVERSE_DELAY_MS : 0, route: "reverse",
        open: () => {
          const pipe = this.reverse;
          this.reverse = null;
          if (!pipe || pipe.destroyed) return Promise.reject(new LinkUnavailableError(LINK_ERROR.noRoute, "the host's tunnel closed"));
          return connectSecure({ creds: this.deps.creds, expectFingerprint: host.id, transport: pipe, timeoutMs: DIAL_TIMEOUT_MS });
        },
      });
    }
    const relayPipe = this.deps.dialRelay;
    if (relayPipe && host.relay) {
      attempts.push({
        // The relay is where the last link lived (the direct addresses didn't
        // answer then): dial it at once instead of after the direct head start.
        delay: attempts.length && this.lastRoute !== "relay" ? RELAY_DELAY_MS : 0, route: "relay",
        open: async () => {
          const pipe = await relayPipe(host);
          if (!pipe) throw new LinkUnavailableError(LINK_ERROR.noRoute, "relay unavailable");
          return connectSecure({ creds: this.deps.creds, expectFingerprint: host.id, transport: pipe, timeoutMs: DIAL_TIMEOUT_MS });
        },
      });
    }
    if (attempts.length === 0) return Promise.reject(new LinkUnavailableError(LINK_ERROR.noRoute, "no address or relay for this host"));

    return new Promise((resolve, reject) => {
      let settled = false;
      let failed = 0;
      let relayIdentityError: PeerIdentityError | null = null;
      let relayDenied = false;
      const failures: DialFailure[] = [];
      for (const a of attempts) {
        setTimeout(() => {
          if (settled) { failed++; return; }
          a.open().then(
            (sock) => {
              if (settled) { sock.destroy(); return; }
              settled = true;
              resolve({ sock, route: a.route });
            },
            (e: unknown) => {
              failures.push(dialFailure(a.route, e));
              // A different key at a LAN address is most likely another machine
              // that inherited the IP; only the relay room — which is this
              // host's alone — proves the host itself changed identity.
              if (e instanceof PeerIdentityError && a.route === "relay") relayIdentityError = e;
              // The relay only turns away a bearer the host withdrew — revoked.
              if (a.route === "relay" && (e as { code?: unknown })?.code === "BEARER_DENIED") relayDenied = true;
              if (++failed === attempts.length && !settled) {
                settled = true;
                const code = blockedFromLocalNetwork(failures) ? LINK_ERROR.localNetwork
                  : e instanceof LinkUnavailableError ? e.code : LINK_ERROR.unreachable;
                reject(relayIdentityError
                  ?? (relayDenied ? new LinkUnavailableError(LINK_ERROR.notPaired, "the host's relay no longer admits this device") : null)
                  ?? new LinkUnavailableError(code, explainDialFailures(failures) || errMsg(e)));
              }
            },
          );
        }, a.delay);
      }
    });
  }

  private adopt(session: http2.ClientHttp2Session, route: LinkRoute): void {
    let refusal: string | null = null;
    session.on("error", () => {});
    session.on("goaway", (_code: number, _last: number, data?: Buffer) => {
      const reason = data?.toString("utf8") ?? "";
      if (reason === PEER_REFUSAL.notPaired || reason === PEER_REFUSAL.hostingOff) refusal = reason;
    });
    session.once("close", () => {
      if (this.session !== session) return;
      this.session = null;
      this.clearTimers();
      if (this.stopped) return;
      if (refusal === PEER_REFUSAL.notPaired) { this.refuse(refusal); return; }
      this.setStatus({ state: "reconnecting", route: null, rttMs: null, error: refusal });
      if (refusal === PEER_REFUSAL.hostingOff) this.scheduleRetry(HOSTING_OFF_RETRY_MS);
      else this.scheduleRetry(0);
    });
    this.session = session;
    this.lastRoute = route;
    this.lastFailure = null;
    // An offer made through the previous session dies with it.
    this.offered = null;
    this.setStatus({ state: "live", route, error: null, attempt: 0 });
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(session); }
    this.waiters = [];
    this.pingTimer = setInterval(() => this.ping(), this.deps.pingIntervalMs ?? PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    this.ping();
    if (route !== "direct" && (this.deps.host()?.addrs.length ?? 0) > 0) {
      const first = setTimeout(() => void this.tryUpgrade(), FIRST_UPGRADE_MS);
      first.unref?.();
      this.upgradeTimer = setInterval(() => void this.tryUpgrade(), UPGRADE_INTERVAL_MS);
      this.upgradeTimer.unref?.();
    }
    void this.refreshInfo(session);
    if (this.deps.onNotification) this.watchNotifications(session);
    this.offerReverse();
  }

  // A filtered event stream (only notification:fire) for as long as this session
  // lives; the next session opens its own.
  private watchNotifications(session: http2.ClientHttp2Session): void {
    let req: http2.ClientHttp2Stream;
    try {
      req = session.request({ ":method": "GET", ":path": "/stream?topics=notification:fire", accept: "text/event-stream" });
    } catch {
      return;
    }
    let buf = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!frame.includes("event: change")) continue;
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          const msg = JSON.parse(line.slice(6)) as { reason?: string; payload?: unknown };
          if (msg.reason === "notification:fire") this.deps.onNotification?.(msg.payload);
        } catch { /* partial or foreign frame */ }
      }
    });
    req.on("error", () => {});
  }

  // On the relay or a tunnel but the host also has direct addresses (the same
  // LAN, a tailnet): once one answers, move the link there. New requests take
  // the new session at once; the old one drains, then its event streams break
  // and the dashboard resumes them from their last event id.
  private async tryUpgrade(): Promise<void> {
    const host = this.deps.host();
    const old = this.session;
    if (this.upgrading || !host || !old || this.state.route === "direct") return;
    const targets = host.addrs.map(parseAddress).filter((t): t is { host: string; port: number } => t != null);
    if (targets.length === 0) return;
    this.upgrading = true;
    try {
      const tries = targets.map((t) => connectSecure({ creds: this.deps.creds, expectFingerprint: host.id, transport: t, timeoutMs: DIAL_TIMEOUT_MS }));
      const sock = await Promise.any(tries);
      for (const t of tries) void t.then((s) => { if (s !== sock) s.destroy(); }, () => {});
      if (this.stopped || this.session !== old) { sock.destroy(); return; }
      this.clearTimers();
      this.adopt(openPeerSession(sock), "direct");
      this.deps.log.info("[hosts] link moved to a direct path", { host: host.name });
      old.close();
      setTimeout(() => { if (!old.destroyed) old.destroy(); }, DRAIN_MS).unref?.();
    } catch {
      // no direct path yet — stay where we are
    } finally {
      this.upgrading = false;
    }
  }

  private ping(): void {
    const s = this.session;
    if (!s || s.destroyed) return;
    const deadline = setTimeout(() => {
      this.deps.log.info("[hosts] ping unanswered — reconnecting", { host: this.deps.host()?.name ?? null });
      s.destroy();
    }, PING_TIMEOUT_MS);
    deadline.unref?.();
    const sent = s.ping((err, duration) => {
      clearTimeout(deadline);
      if (err || this.session !== s) return;
      const prev = this.state.rttMs;
      const rtt = prev == null ? duration : prev * 0.7 + duration * 0.3;
      this.setStatus({ rttMs: Math.round(rtt * 10) / 10 });
    });
    if (!sent) clearTimeout(deadline);
  }

  private async refreshInfo(session: http2.ClientHttp2Session): Promise<void> {
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = session.request({ ":method": "GET", ":path": ROUTES.hostInfo });
        let data = "";
        req.setEncoding("utf8");
        req.on("data", (d: string) => { data += d; });
        req.on("end", () => resolve(data));
        req.on("error", reject);
        req.end();
      });
      const parsed = HostInfoSchema.safeParse(JSON.parse(body));
      if (!parsed.success) return;
      this.hostInfo = parsed.data;
      this.deps.onInfo?.(parsed.data);
      this.deps.onChange();
    } catch { /* the link state machine handles a dying session */ }
  }

  private refuse(code: string): void {
    this.clearTimers();
    this.setStatus({ state: "unauthorized", route: null, rttMs: null, error: code });
    this.rejectWaiters(new LinkUnavailableError(code, "host refused this device"));
  }

  private scheduleRetry(delayMs?: number): void {
    if (this.stopped || this.retryTimer) return;
    const idx = Math.min(this.state.attempt, BACKOFF_MS.length - 1);
    const base = delayMs ?? BACKOFF_MS[idx];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, delay);
    this.retryTimer.unref?.();
  }

  private rejectWaiters(e: Error): void {
    for (const w of this.waiters) { clearTimeout(w.timer); w.reject(e); }
    this.waiters = [];
  }

  private clearTimers(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.upgradeTimer) { clearInterval(this.upgradeTimer); this.upgradeTimer = null; }
  }

  private setStatus(patch: Partial<LinkStatus>): void {
    const next = { ...this.state, ...patch };
    const changedState = next.state !== this.state.state || next.route !== this.state.route;
    if (changedState) next.since = this.deps.now();
    const changed = changedState || next.rttMs !== this.state.rttMs || next.error !== this.state.error || next.attempt !== this.state.attempt;
    this.state = next;
    if (changed) this.deps.onChange();
  }
}
