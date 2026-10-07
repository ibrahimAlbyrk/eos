import { BrowserWindow, WebContentsView, ipcMain, session, shell } from "electron";
import type { Session, WebContents } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Other computers this Mac controls, each in its own isolated view INSIDE the
// main window: switching is showing a different, already-live view — no reload,
// no lost scroll or draft. Every view gets its own session partition (its own
// localStorage, cache, cookies) and talks only to its host's facade prefix on
// the local daemon (/h/<id>/…).
//
// A view runs this Mac's dashboard whenever it speaks the host's API, and the
// host's own bundle only when it doesn't (so UI and daemon always match). That
// code is the host's, not ours: it never sees this Mac's ui-token
// (it gets a token valid only under its own /h/<id>/ prefix), its CSP pins every
// fetch to that prefix, and its preload omits the bridges that touch this Mac's
// files. The worst a compromised host can do from its view is what it could
// already do on itself.

export interface HostLink {
  state: "connecting" | "live" | "reconnecting" | "offline" | "unauthorized" | "incompatible";
  route: "direct" | "relay" | "reverse" | null;
  rttMs: number | null;
  error: string | null;
}

export interface HostView {
  id: string;
  name: string;
  alias: string | null;
  deviceId: string;
  platform: string;
  link: HostLink;
  info: HostInfo | null;
}

interface HostInfo { servesUi: boolean; apiStamp: string; home: string; name: string }

interface Deps {
  win: BrowserWindow;
  daemonUrl: string;
  rawUrl: string;
  uiToken: string;
  uiRoot: string;
  preload: string;
  // Build the host view's CSP for its facade prefixes.
  csp: (apiBase: string, rawBase: string) => string | null;
  onChange?: () => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ico": "image/x-icon", ".wasm": "application/wasm",
};

function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

interface HostBundle {
  // Whose dashboard this host's views run: ours when it speaks the host's API
  // (one look on every computer, nothing to download), else the host's own —
  // or ours when it serves none (or is unreachable at load time).
  source: "host" | "local";
}

export class HostViews {
  private readonly deps: Deps;
  private hosts: HostView[] = [];
  // This Mac as its daemon describes itself — views of other computers can't ask it.
  private local: { name: string; platform: string; deviceId: string } | null = null;
  // The API our own dashboard bundle speaks.
  private localApiStamp: string | null = null;
  private readonly views = new Map<string, WebContentsView>();
  private readonly pending = new Map<string, Promise<WebContentsView>>();
  private readonly bundles = new Map<string, HostBundle>();
  // Each host's view token, and the hosts whose session already carries it.
  private readonly viewTokens = new Map<string, string>();
  private readonly tokenHeaders = new Set<string>();
  // Hosts opened in a window of their own ("Open in Window"), and whose each is.
  private readonly windows = new Set<BrowserWindow>();
  private readonly windowHosts = new Map<BrowserWindow, string>();
  private active: string | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
    deps.win.on("resize", () => this.layout());
    // A reactivated window hands focus to its own page, hidden under the host
    // view — then ⌘V lands nowhere and copy buttons fail ("not focused").
    deps.win.on("focus", () => { if (this.active) this.views.get(this.active)?.webContents.focus(); });
    // A view off screen pauses its live stream (it runs over the link to the
    // other computer); Chromium doesn't report a detached view as hidden.
    const tell = (): void => this.tellActiveVisibility();
    deps.win.on("minimize", tell);
    deps.win.on("restore", tell);
    deps.win.on("hide", tell);
    deps.win.on("show", tell);
    ipcMain.handle("eosHosts:list", () => this.snapshot());
    ipcMain.on("eosHosts:switch", (_e, id: unknown) => void this.switchTo(typeof id === "string" ? id : null));
    ipcMain.on("eosHosts:openWindow", (_e, id: unknown) => { if (typeof id === "string") void this.openInWindow(id); });
    ipcMain.on("eosHosts:reconnect", (_e, id: unknown) => { if (typeof id === "string") void this.reconnect(id); });
    // A controlled computer's view can't manage pairing (it never holds this Mac's
    // token): bring this Mac's view forward with its Connect sheet open.
    ipcMain.on("eosHosts:requestConnect", () => {
      void this.switchTo(null);
      this.deps.win.webContents.send("eosHosts:command", { type: "connect" });
    });
  }

  current(): string | null { return this.active; }
  list(): HostView[] { return this.hosts; }

  snapshot(): { hosts: HostView[]; active: string | null; local: { name: string; platform: string; deviceId: string } | null } {
    return { hosts: this.hosts, active: this.active, local: this.local };
  }

  async refresh(): Promise<void> {
    if (!this.local) {
      try {
        const info = (await (await fetch(`${this.deps.daemonUrl}/api/host`)).json()) as { name?: string; platform?: string; deviceId?: string; apiStamp?: string };
        if (info.name) this.local = { name: info.name, platform: info.platform ?? "darwin", deviceId: info.deviceId ?? "" };
        this.localApiStamp = info.apiStamp ?? null;
      } catch { /* retried on the next refresh */ }
    }
    try {
      const res = await fetch(`${this.deps.daemonUrl}/api/hosts`, { headers: { "x-eos-ui-token": this.deps.uiToken } });
      if (!res.ok) return;
      const body = (await res.json()) as { hosts?: HostView[] };
      this.hosts = Array.isArray(body.hosts) ? body.hosts : [];
    } catch {
      return;
    }
    // A forgotten host's view goes with it.
    for (const id of [...this.views.keys()]) {
      if (!this.hosts.some((h) => h.id === id)) this.dispose(id);
      // Opened while the daemon couldn't mint one — without it the view gets nothing.
      else if (!this.viewTokens.get(id)) void this.mintViewToken(id);
    }
    if (this.active && !this.hosts.some((h) => h.id === this.active)) await this.switchTo(null);
    this.broadcast();
    this.deps.onChange?.();
  }

  // null = this Mac.
  async switchTo(id: string | null): Promise<void> {
    const { win } = this.deps;
    if (win.isDestroyed()) return;
    if (id && !this.hosts.some((h) => h.id === id)) return;
    if (this.active === id) return;
    const prev = this.active ? this.views.get(this.active) : null;
    if (prev) {
      win.contentView.removeChildView(prev);
      tellVisibility(prev, false);
    }
    this.active = id;
    this.broadcast();
    this.deps.onChange?.();
    if (!id) { win.webContents.focus(); return; }
    const view = await this.ensureView(id);
    // The user may have switched again while the view was being built.
    if (this.active !== id || win.isDestroyed()) return;
    win.contentView.addChildView(view);
    tellVisibility(view, this.windowShown());
    this.layout();
    view.webContents.focus();
  }

  private windowShown(): boolean {
    const { win } = this.deps;
    return !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  }

  private tellActiveVisibility(): void {
    const view = this.active ? this.views.get(this.active) : null;
    if (view) tellVisibility(view, this.windowShown());
  }

  // The web contents that has the user's attention — the menu's edit commands
  // and reload act on it.
  focusedContents(): WebContents {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && this.windows.has(focused)) return focused.webContents;
    const view = this.active ? this.views.get(this.active) : null;
    return view ? view.webContents : this.deps.win.webContents;
  }

  allContents(): WebContents[] {
    return [this.deps.win.webContents, ...[...this.views.values()].map((v) => v.webContents)];
  }

  // The controlled computer a renderer shows, and whether it runs this Mac's own
  // dashboard (code we trust) rather than that computer's. null = not a host view.
  hostFor(wc: WebContents): { id: string; trusted: boolean } | null {
    let id: string | null = null;
    for (const [hostId, view] of this.views) if (view.webContents === wc) id = hostId;
    for (const [win, hostId] of this.windowHosts) if (!win.isDestroyed() && win.webContents === wc) id = hostId;
    return id ? { id, trusted: this.bundles.get(id)?.source === "local" } : null;
  }

  // Every renderer showing another computer.
  hostContents(): WebContents[] {
    return [...new Set([...this.views.keys(), ...this.windowHosts.values()])].flatMap((id) => this.contentsFor(id));
  }

  // Every renderer showing `id` (its view, and any window of its own).
  contentsFor(id: string): WebContents[] {
    const out: WebContents[] = [];
    const view = this.views.get(id);
    if (view && !view.webContents.isDestroyed()) out.push(view.webContents);
    for (const [win, hostId] of this.windowHosts) if (hostId === id && !win.isDestroyed()) out.push(win.webContents);
    return out;
  }

  private async reconnect(id: string): Promise<void> {
    try {
      await fetch(`${this.deps.daemonUrl}/api/hosts/${id}/reconnect`, { method: "POST", headers: { "x-eos-ui-token": this.deps.uiToken } });
    } catch { /* the link reports its own state */ }
  }

  private async openInWindow(id: string): Promise<void> {
    const host = this.hosts.find((h) => h.id === id);
    if (!host) return;
    const win = new BrowserWindow({
      width: 1280, height: 820, minWidth: 800, minHeight: 500,
      title: `Eos — ${host.alias ?? host.name}`,
      titleBarStyle: "hiddenInset", backgroundColor: "#101010",
      webPreferences: await this.webPreferences(id),
    });
    this.lockdown(win.webContents);
    this.windows.add(win);
    this.windowHosts.set(win, id);
    win.on("closed", () => { this.windows.delete(win); this.windowHosts.delete(win); });
    await win.loadURL("eos://app/index.html");
  }

  private ensureView(id: string): Promise<WebContentsView> {
    const existing = this.views.get(id);
    if (existing) return Promise.resolve(existing);
    let inflight = this.pending.get(id);
    if (!inflight) {
      inflight = this.webPreferences(id).then((webPreferences) => {
        const view = new WebContentsView({ webPreferences });
        view.setBackgroundColor("#101010");
        this.lockdown(view.webContents);
        void view.webContents.loadURL("eos://app/index.html");
        this.views.set(id, view);
        this.pending.delete(id);
        return view;
      });
      this.pending.set(id, inflight);
    }
    return inflight;
  }

  private async webPreferences(id: string): Promise<Electron.WebPreferences> {
    const host = this.hosts.find((h) => h.id === id);
    const apiBase = `${this.deps.daemonUrl}/h/${id}`;
    const rawBase = `${this.deps.rawUrl}/h/${id}`;
    const partition = `persist:eos-host-${id.slice(0, 32)}`;
    const ses = session.fromPartition(partition);
    this.installProtocol(id, ses, apiBase, rawBase);
    this.installTokenHeader(id, ses, apiBase, rawBase);
    const token = await this.mintViewToken(id);
    const descriptor = Buffer.from(JSON.stringify({
      id, remote: true, name: host?.alias ?? host?.name ?? "Remote Mac", deviceId: host?.deviceId ?? "",
      home: host?.info?.home ?? null,
    })).toString("base64");
    return {
      preload: this.deps.preload,
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      additionalArguments: [
        `--eos-daemon-url=${apiBase}`,
        `--eos-raw-url=${rawBase}`,
        `--eos-ui-token=${token}`,
        `--eos-host=${descriptor}`,
      ],
    };
  }

  private async mintViewToken(id: string): Promise<string> {
    try {
      const res = await fetch(`${this.deps.daemonUrl}/api/hosts/${id}/view-token`, {
        method: "POST", headers: { "x-eos-ui-token": this.deps.uiToken },
      });
      const body = (await res.json()) as { token?: string };
      const token = typeof body.token === "string" ? body.token : "";
      if (token) this.viewTokens.set(id, token);
      return token;
    } catch {
      return "";
    }
  }

  // The host refuses anything that isn't the user's dashboard, and an <img>,
  // <video>, EventSource or pdf.js load can't add a header itself — so every
  // request this view makes to its host's prefix carries the view token.
  private installTokenHeader(id: string, ses: Session, apiBase: string, rawBase: string): void {
    if (this.tokenHeaders.has(id)) return;
    this.tokenHeaders.add(id);
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const token = this.viewTokens.get(id);
      const toHost = details.url.startsWith(`${apiBase}/`) || details.url.startsWith(`${rawBase}/`);
      callback({ requestHeaders: token && toHost ? { ...details.requestHeaders, "x-eos-ui-token": token } : details.requestHeaders });
    });
  }

  // Serves a host view's dashboard. Decided once per page load (at index.html)
  // so a page never mixes two builds.
  private installProtocol(id: string, ses: Session, apiBase: string, rawBase: string): void {
    if (this.bundles.has(id)) return;
    const bundle: HostBundle = { source: "local" };
    this.bundles.set(id, bundle);
    const localRoot = path.resolve(this.deps.uiRoot);
    ses.protocol.handle("eos", async (request) => {
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return notFound(); }
      if (pathname === "" || pathname === "/") pathname = "/index.html";
      const isEntry = pathname === "/index.html";
      if (isEntry) bundle.source = await this.bundleSource(id, apiBase);
      const headers: Record<string, string> = {};
      const csp = isEntry ? this.deps.csp(apiBase, rawBase) : null;
      if (csp) headers["content-security-policy"] = csp;

      const local = path.resolve(localRoot, "." + pathname);
      if (local !== localRoot && !local.startsWith(localRoot + path.sep)) return notFound();
      // A fingerprinted asset this Mac already has is byte-for-byte the host's.
      if (bundle.source === "local" || pathname.startsWith("/assets/")) {
        try {
          const data = await readFile(local);
          return new Response(new Uint8Array(data), { status: 200, headers: { ...headers, "content-type": mimeFor(local) } });
        } catch {
          if (bundle.source === "local") return notFound();
        }
      }
      try {
        // Through the view's own session: its HTTP cache keeps the host's
        // immutable assets across launches, so a reopen costs no WAN trip.
        const res = await ses.fetch(`${apiBase}/ui${pathname}`);
        if (!res.ok) return notFound();
        const body = await res.arrayBuffer();
        return new Response(body, { status: 200, headers: { ...headers, "content-type": res.headers.get("content-type") ?? mimeFor(pathname) } });
      } catch {
        return notFound();
      }
    });
  }

  // Ours whenever it speaks the host's API; the host's own bundle only when it
  // doesn't (an older or newer Eos there), or ours when it serves none.
  private async bundleSource(id: string, apiBase: string): Promise<HostBundle["source"]> {
    const info = this.hosts.find((h) => h.id === id)?.info ?? (await this.fetchHostInfo(apiBase));
    if (!info?.servesUi) return "local";
    return info.apiStamp === this.localApiStamp ? "local" : "host";
  }

  // Only before the link has reported the host's info.
  private async fetchHostInfo(apiBase: string): Promise<HostInfo | null> {
    try {
      const res = await fetch(`${apiBase}/api/host`, { signal: AbortSignal.timeout(4000) });
      return res.ok ? ((await res.json()) as HostInfo) : null;
    } catch {
      return null;
    }
  }

  private lockdown(wc: WebContents): void {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:|^mailto:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("will-navigate", (e, url) => {
      if (url.startsWith("eos://app/")) return;
      e.preventDefault();
      if (/^https?:|^mailto:/i.test(url)) void shell.openExternal(url);
    });
    wc.on("context-menu", (e) => e.preventDefault());
  }

  private layout(): void {
    const { win } = this.deps;
    if (win.isDestroyed() || !this.active) return;
    const view = this.views.get(this.active);
    if (!view) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  }

  private dispose(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    if (this.active === id) this.deps.win.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(id);
    this.viewTokens.delete(id);
  }

  private broadcast(): void {
    const snap = this.snapshot();
    for (const wc of this.allContents()) {
      if (!wc.isDestroyed()) wc.send("eosHosts:changed", snap);
    }
  }
}

function tellVisibility(view: WebContentsView, visible: boolean): void {
  if (!view.webContents.isDestroyed()) view.webContents.send("eosHosts:visibility", visible);
}

function notFound(): Response {
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
}
