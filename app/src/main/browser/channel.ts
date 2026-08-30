import { app } from "electron";

// HostChannel — the app half of the /browser/host control channel. Opens a
// persistent WS to the daemon (the app is always the daemon's WS client),
// registers as the single browser host, then serves the daemon's port-method
// RPCs from the driver and pushes unsolicited tab events back. One frame per
// port verb (not per CDP call). Loopback + uiToken, matching the frame WS gate.
//
// Transport is the WHATWG global WebSocket (present in Electron's Node runtime),
// so no ws dependency is bundled into the app. A single long-lived connection
// never churns ephemeral ports, so TCP loopback is used directly.

interface Driver {
  handle(method: string, sessionKey: string, args: unknown[]): Promise<unknown>;
}

interface Frame {
  type?: string;
  id?: number;
  sessionKey?: string;
  method?: string;
  args?: unknown[];
}

const RECONNECT_MS = 1500;

export class HostChannel {
  private url: string;
  private ws: WebSocket | null = null;
  private driver: Driver | null = null;
  private registered = false;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: { daemonUrl: string; uiToken: string }) {
    const wsBase = deps.daemonUrl.replace(/^http/i, "ws");
    this.url = `${wsBase}/browser/host?uiToken=${encodeURIComponent(deps.uiToken)}`;
  }

  setDriver(driver: Driver): void {
    this.driver = driver;
  }

  start(): void {
    if (typeof WebSocket === "undefined") {
      console.error("[eos-browser] no global WebSocket in this runtime — embedded browser host disabled");
      return;
    }
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { this.ws?.close(); } catch { /* already closing */ }
    this.ws = null;
  }

  // Push a tab event to the daemon (tabsChanged/activeTabChanged/tabCrashed).
  emitEvent(sessionKey: string, event: string, payload?: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || !this.registered) return;
    try {
      ws.send(JSON.stringify({ type: "event", sessionKey, event, payload }));
    } catch { /* socket died mid-send; the daemon will re-read on reconnect */ }
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      console.error("[eos-browser] host WS connect failed:", e instanceof Error ? e.message : String(e));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.registered = false;
    ws.addEventListener("open", () => {
      try {
        ws.send(JSON.stringify({ type: "register", role: "browser-host", appVersion: safeVersion(), pid: process.pid }));
      } catch { /* closed immediately */ }
    });
    ws.addEventListener("message", (ev) => void this.onMessage(String((ev as MessageEvent).data)));
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.registered = false;
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* already closed */ }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  private async onMessage(raw: string): Promise<void> {
    let frame: Frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.type === "registered") {
      this.registered = true;
      console.log("[eos-browser] registered as browser host");
      return;
    }
    if (typeof frame.id !== "number" || typeof frame.method !== "string") return;
    const ws = this.ws;
    if (!ws) return;
    try {
      const result = this.driver
        ? await this.driver.handle(frame.method, frame.sessionKey ?? "", frame.args ?? [])
        : null;
      ws.send(JSON.stringify({ id: frame.id, ok: true, result }));
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      const message = e instanceof Error ? e.message : String(e);
      try { ws.send(JSON.stringify({ id: frame.id, ok: false, error: { name, message } })); } catch { /* socket gone */ }
    }
  }
}

function safeVersion(): string {
  try { return app.getVersion(); } catch { return ""; }
}
