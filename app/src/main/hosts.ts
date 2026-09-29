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
// A view may run the host's own dashboard bundle (so UI and daemon always
// match). That code is the host's, not ours: it never sees this Mac's ui-token
// (it gets a token valid only under its own /h/<id>/ prefix), its CSP pins every
// fetch to that prefix, and its preload omits the bridges that touch this Mac's
// files. The worst a compromised host can do from its view is what it could
// already do on itself.

export interface HostLink {
  state: "connecting" | "live" | "reconnecting" | "offline" | "unauthorized" | "incompatible";
  route: "direct" | "relay" | null;
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
  info: { servesUi: boolean; home: string; name: string } | null;
}

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
  // Whose dashboard this host's views run: the host's own, or ours when it
  // serves none (or is unreachable at load time).
  source: "host" | "local";
  // Fingerprinted assets never change — keep them so a reopen costs no WAN trip.
  assets: Map<string, { body: ArrayBuffer; type: string }>;
}

export class HostViews {
  private readonly deps: Deps;
  private hosts: HostView[] = [];
  // This Mac as its daemon describes itself — views of other computers can't ask it.
  private local: { name: string; platform: string; deviceId: string } | null = null;
  private readonly views = new Map<string, WebContentsView>();
  private readonly pending = new Map<string, Promise<WebContentsView>>();
  private readonly bundles = new Map<string, HostBundle>();
  private active: string | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
    deps.win.on("resize", () => this.layout());
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
        const info = (await (await fetch(`${this.deps.daemonUrl}/api/host`)).json()) as { name?: string; platform?: string; deviceId?: string };
        if (info.name) this.local = { name: info.name, platform: info.platform ?? "darwin", deviceId: info.deviceId ?? "" };
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
    if (prev) win.contentView.removeChildView(prev);
    this.active = id;
    this.broadcast();
    this.deps.onChange?.();
    if (!id) { win.webContents.focus(); return; }
    const view = await this.ensureView(id);
    // The user may have switched again while the view was being built.
    if (this.active !== id || win.isDestroyed()) return;
    win.contentView.addChildView(view);
    this.layout();
    view.webContents.focus();
  }

  // The web contents that has the user's attention — the menu's edit commands
  // and reload act on it.
  focusedContents(): WebContents {
    const view = this.active ? this.views.get(this.active) : null;
    return view ? view.webContents : this.deps.win.webContents;
  }

  allContents(): WebContents[] {
    return [this.deps.win.webContents, ...[...this.views.values()].map((v) => v.webContents)];
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
    this.installProtocol(id, session.fromPartition(partition), apiBase, rawBase);
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
      return typeof body.token === "string" ? body.token : "";
    } catch {
      return "";
    }
  }

  // Serves the host's dashboard: its own bundle through the facade when it
  // offers one, else ours. Decided once per page load (at index.html) so a page
  // never mixes two builds.
  private installProtocol(id: string, ses: Session, apiBase: string, rawBase: string): void {
    if (this.bundles.has(id)) return;
    const bundle: HostBundle = { source: "local", assets: new Map() };
    this.bundles.set(id, bundle);
    const localRoot = path.resolve(this.deps.uiRoot);
    ses.protocol.handle("eos", async (request) => {
      let pathname: string;
      try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return notFound(); }
      if (pathname === "" || pathname === "/") pathname = "/index.html";
      const isEntry = pathname === "/index.html";
      if (isEntry) bundle.source = (await this.hostServesUi(apiBase)) ? "host" : "local";
      const headers: Record<string, string> = {};
      const csp = isEntry ? this.deps.csp(apiBase, rawBase) : null;
      if (csp) headers["content-security-policy"] = csp;

      if (bundle.source === "host") {
        const cached = bundle.assets.get(pathname);
        if (cached) return new Response(cached.body.slice(0), { status: 200, headers: { ...headers, "content-type": cached.type } });
        try {
          const res = await fetch(`${apiBase}/ui${pathname}`);
          if (!res.ok) return notFound();
          const body = await res.arrayBuffer();
          const type = res.headers.get("content-type") ?? mimeFor(pathname);
          if (pathname.startsWith("/assets/")) bundle.assets.set(pathname, { body, type });
          return new Response(body, { status: 200, headers: { ...headers, "content-type": type } });
        } catch {
          return notFound();
        }
      }
      const resolved = path.resolve(localRoot, "." + pathname);
      if (resolved !== localRoot && !resolved.startsWith(localRoot + path.sep)) return notFound();
      try {
        const data = await readFile(resolved);
        return new Response(new Uint8Array(data), { status: 200, headers: { ...headers, "content-type": mimeFor(resolved) } });
      } catch {
        return notFound();
      }
    });
  }

  private async hostServesUi(apiBase: string): Promise<boolean> {
    try {
      const res = await fetch(`${apiBase}/api/host`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return false;
      const info = (await res.json()) as { servesUi?: unknown };
      return info.servesUi === true;
    } catch {
      return false;
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
  }

  private broadcast(): void {
    const snap = this.snapshot();
    for (const wc of this.allContents()) {
      if (!wc.isDestroyed()) wc.send("eosHosts:changed", snap);
    }
  }
}

function notFound(): Response {
  return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
}
