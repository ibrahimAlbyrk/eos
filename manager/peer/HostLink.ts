// Device side of one peer link: keeps an HTTP/2 session to a controlled host
// alive and tells the rest of the daemon how that link is doing.
//
// Connecting races every route the host might be on (its LAN/tailnet addresses,
// then the relay) and keeps the first one that proves the pinned identity.
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

// Error codes surfaced in LinkStatus.error — the UI maps them to copy.
export const LINK_ERROR = {
  identityChanged: "identity-changed",
  notPaired: PEER_REFUSAL.notPaired,
  hostingOff: PEER_REFUSAL.hostingOff,
  noRoute: "no-route",
  unreachable: "unreachable",
} as const;

const DIAL_TIMEOUT_MS = 6_000;
// Direct candidates start this far apart; the relay joins after them so a
// reachable LAN address wins without waiting for the relay handshake.
const STAGGER_MS = 150;
const RELAY_DELAY_MS = 400;
const PING_INTERVAL_MS = 10_000;
const PING_TIMEOUT_MS = 6_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
// Remote access switched off on the host: check back now and then, not in a loop.
const HOSTING_OFF_RETRY_MS = 30_000;
// On the relay, look for a direct path this often (and on every network change).
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
    this.rejectWaiters(new LinkUnavailableError(LINK_ERROR.unreachable, "link stopped"));
    this.setStatus({ state: "offline", route: null, rttMs: null, error: null, attempt: 0 });
  }

  // Something changed that may have broken or healed the path (network switch,
  // wake from sleep, the user pressing Reconnect): probe now instead of waiting.
  kick(): void {
    if (this.stopped) return;
    if (this.session) {
      this.ping();
      if (this.state.route === "relay") void this.tryUpgrade();
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
        this.setStatus({ state: "reconnecting", route: null, rttMs: null, error: code });
        this.scheduleRetry();
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
    const relayPipe = this.deps.dialRelay;
    if (relayPipe && host.relay) {
      attempts.push({
        delay: attempts.length ? RELAY_DELAY_MS : 0, route: "relay",
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
              // A different key at a LAN address is most likely another machine
              // that inherited the IP; only the relay room — which is this
              // host's alone — proves the host itself changed identity.
              if (e instanceof PeerIdentityError && a.route === "relay") relayIdentityError = e;
              // The relay only turns away a bearer the host withdrew — revoked.
              if (a.route === "relay" && (e as { code?: unknown })?.code === "BEARER_DENIED") relayDenied = true;
              if (++failed === attempts.length && !settled) {
                settled = true;
                reject(relayIdentityError
                  ?? (relayDenied ? new LinkUnavailableError(LINK_ERROR.notPaired, "the host's relay no longer admits this device") : null)
                  ?? (e instanceof LinkUnavailableError ? e : new LinkUnavailableError(LINK_ERROR.unreachable, errMsg(e))));
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
    this.setStatus({ state: "live", route, error: null, attempt: 0 });
    for (const w of this.waiters) { clearTimeout(w.timer); w.resolve(session); }
    this.waiters = [];
    this.pingTimer = setInterval(() => this.ping(), this.deps.pingIntervalMs ?? PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    this.ping();
    if (route === "relay" && (this.deps.host()?.addrs.length ?? 0) > 0) {
      const first = setTimeout(() => void this.tryUpgrade(), FIRST_UPGRADE_MS);
      first.unref?.();
      this.upgradeTimer = setInterval(() => void this.tryUpgrade(), UPGRADE_INTERVAL_MS);
      this.upgradeTimer.unref?.();
    }
    void this.refreshInfo(session);
    if (this.deps.onNotification) this.watchNotifications(session);
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

  // On the relay but the host also has direct addresses (the same LAN, a
  // tailnet): once one answers, move the link there. New requests take the new
  // session at once; the old one drains, then its event streams break and the
  // dashboard resumes them from their last event id.
  private async tryUpgrade(): Promise<void> {
    const host = this.deps.host();
    const old = this.session;
    if (this.upgrading || !host || !old || this.state.route !== "relay") return;
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
      // no direct path yet — stay on the relay
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
