// /browser/host — the daemon↔app control channel for the embedded-browser lane.
// The Electron app connects here and registers as the single "browser host";
// the daemon then drives the app's WebContentsView views by RPCing BrowserEngine
// port methods over this socket (one hop per verb). Gated loopback + uiToken (the
// standard local WS gate). Direction matches the only client
// relationship that exists — the app is always the daemon's WS client, and the
// single-instance lock means at most one host, so view ownership is never
// contested.
//
// Wire frames:
//   register (app→daemon):  { type:"register", role:"browser-host", appVersion, pid }
//   ack      (daemon→app):  { type:"registered" }
//   rpc      (daemon→app):  { id, sessionKey, method, args }
//   reply    (app→daemon):  { id, ok:true, result } | { id, ok:false, error:{name,message} }
//   event    (app→daemon):  { type:"event", sessionKey, event, payload }

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { RemoteBrowserChannel } from "../infra/src/browser/RemoteBrowserEngine.ts";

export const BROWSER_HOST_PATH = "/browser/host";

// A port method can span a page load (navigate) or a full a11y tree walk
// (snapshot) — generous, and the app replies immediately on error either way.
const RPC_TIMEOUT_MS = 30_000;

interface HostLog {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

interface Frame {
  id?: number;
  ok?: boolean;
  result?: unknown;
  error?: { name?: string; message?: string };
  type?: string;
  role?: string;
  pid?: number;
  appVersion?: string;
  sessionKey?: string;
  event?: string;
  payload?: unknown;
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// One session's view onto the host socket. Persisted only while the host is
// connected — dropped on disconnect so a reconnect rebuilds fresh listeners.
class SessionChannel implements RemoteBrowserChannel {
  private host: AppBrowserHost;
  private sessionKey: string;
  private eventCbs = new Set<(event: string, payload: unknown) => void>();
  private closeCbs = new Set<() => void>();

  constructor(host: AppBrowserHost, sessionKey: string) {
    this.host = host;
    this.sessionKey = sessionKey;
  }

  call(method: string, args: unknown[]): Promise<unknown> {
    return this.host.rpc(this.sessionKey, method, args);
  }
  onEvent(cb: (event: string, payload: unknown) => void): void {
    this.eventCbs.add(cb);
  }
  onClose(cb: () => void): void {
    this.closeCbs.add(cb);
  }
  isOpen(): boolean {
    return this.host.isRegistered();
  }
  emit(event: string, payload: unknown): void {
    for (const cb of this.eventCbs) cb(event, payload);
  }
  fireClose(): void {
    for (const cb of this.closeCbs) cb();
  }
}

export class AppBrowserHost {
  private ws: WebSocket | null = null;
  private frameId = 0;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private channels = new Map<string, SessionChannel>();
  private deregisterCbs: Array<() => void> = [];
  private log: HostLog;

  constructor(deps: { log: HostLog }) {
    this.log = deps.log;
  }

  isRegistered(): boolean {
    return this.ws != null;
  }

  // Fires whenever the host disconnects — the composition root resets the engine
  // slots so the next launch re-picks the factory (falls back to headless).
  onDeregister(cb: () => void): void {
    this.deregisterCbs.push(cb);
  }

  channelFor(sessionKey: string): RemoteBrowserChannel {
    let ch = this.channels.get(sessionKey);
    if (!ch) {
      ch = new SessionChannel(this, sessionKey);
      this.channels.set(sessionKey, ch);
    }
    return ch;
  }

  // Send one port-method RPC and await the app's reply. Rejects with an Error
  // whose `.name` is the remote error's class so StaleRefError survives the hop.
  rpc(sessionKey: string, method: string, args: unknown[]): Promise<unknown> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("browser host not connected"));
    const id = ++this.frameId;
    try {
      ws.send(JSON.stringify({ id, sessionKey, method, args }));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`browser host RPC timeout: ${method}`));
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  // Called by the upgrade handler once a socket passes the loopback+uiToken gate.
  attach(ws: WebSocket): void {
    ws.on("message", (raw) => this.onMessage(ws, raw));
    ws.on("close", () => this.onSocketClose(ws));
    ws.on("error", () => this.onSocketClose(ws));
  }

  private onMessage(ws: WebSocket, raw: unknown): void {
    let frame: Frame;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (frame.type === "register") {
      // Single-instance lock means one host, but be defensive: a new register
      // supersedes any stale socket.
      if (this.ws && this.ws !== ws) {
        try { this.ws.close(); } catch { /* already gone */ }
      }
      this.ws = ws;
      this.log.info("browser host registered", { pid: frame.pid, appVersion: frame.appVersion });
      try { ws.send(JSON.stringify({ type: "registered" })); } catch { /* socket died mid-handshake */ }
      return;
    }
    if (this.ws !== ws) return; // frames from a superseded socket
    if (typeof frame.id === "number") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok === false) {
        const err = new Error(frame.error?.message ?? "remote browser error");
        if (frame.error?.name) err.name = frame.error.name;
        p.reject(err);
      } else {
        p.resolve(frame.result);
      }
      return;
    }
    if (frame.type === "event" && typeof frame.sessionKey === "string" && typeof frame.event === "string") {
      this.channels.get(frame.sessionKey)?.emit(frame.event, frame.payload);
    }
  }

  private onSocketClose(ws: WebSocket): void {
    if (this.ws !== ws) return; // a superseded socket closing — ignore
    this.ws = null;
    this.log.info("browser host disconnected");
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("browser host disconnected"));
    }
    this.pending.clear();
    // Signal every live engine (onExit) then drop the channels so a reconnect
    // rebuilds fresh listeners.
    for (const ch of this.channels.values()) ch.fireClose();
    this.channels.clear();
    for (const cb of this.deregisterCbs) cb();
  }
}

export function makeBrowserHostUpgradeHandler(deps: {
  host: AppBrowserHost;
  uiToken: string;
  log: HostLog;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws: WebSocket) => deps.host.attach(ws));
  return (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== BROWSER_HOST_PATH) {
      socket.destroy();
      return;
    }
    // Same two locks as the frame WS: loopback + ui-token (query string, since a
    // WS client can't set handshake headers).
    if (!isLoopback(req.socket.remoteAddress) || url.searchParams.get("uiToken") !== deps.uiToken) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  };
}
