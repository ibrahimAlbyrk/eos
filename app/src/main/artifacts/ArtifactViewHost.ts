import { WebContentsView, shell } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { artifactViewerUrl } from "../../../../contracts/src/artifact-ids";
import { StillCapture } from "./capture";
import { syncOverlay } from "./overlay";
import { applyPlacement, hiddenRect, setZoom, syncThrottle } from "./placement";
import { pickEvictions } from "./pool";
import type { ClaudeSessions } from "./sessions";
import { StillStore } from "./stills";
import { later, newEntry, type ArtifactRef, type Entry, type Rect, type TabPlace, type ViewState } from "./types";
import { wireView } from "./viewEvents";

// claude.ai Artifacts as native views over the dashboard. claude.ai and the
// content host forbid being framed by eos://app, so an artifact renders only as
// a top-level document: the claude.ai viewer page in a WebContentsView, in the
// claude.ai partition of the sign-in that owns it (sessions.ts).
//
// One live view per artifact, three places: warm (hidden, loading), the hover
// peek (a half-zoom miniature) and a side-panel tab. The same webContents moves
// between them, so hover → open costs no reload. A view is in one place at a
// time; the newest attach/peek takes it. While a view isn't ready it stays
// hidden and the renderer paints the artifact's last still (stills.ts).

interface Deps {
  getWin: () => BrowserWindow | null;
  sessions: ClaudeSessions;
  overlayPreload: string;
  stillsDir: string;
  // Another computer's view covers the dashboard: keep every artifact view hidden.
  covered?: () => boolean;
}

const POOL_CAP = 4;
const IDLE_MS = 5 * 60_000;
const LOAD_TIMEOUT_MS = 30_000;

export class ArtifactViewHost {
  private readonly deps: Deps;
  private readonly stills: StillStore;
  private readonly stillCapture: StillCapture;
  private readonly entries = new Map<string, Entry>();
  private peeked: Entry | null = null;
  private win: BrowserWindow | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
    this.stills = new StillStore(deps.stillsDir);
    this.stillCapture = new StillCapture(this.stills, {
      done: (e) => syncThrottle(e),
      // Said again so a renderer that found no still on `ready` asks once more.
      written: (e) => this.send("eosArtifacts:stateChanged", { slug: e.slug, state: "ready" }),
    });
    deps.sessions.onSignedIn = (partition) => this.resume(partition);
    deps.sessions.onSignedOut = (partition) => this.signedOut(partition);
    deps.sessions.onRelinked = (loginId) => this.relink(loginId);
    setInterval(() => this.trim(), 60_000).unref();
  }

  // ---- renderer verbs ------------------------------------------------------

  warm(ref: ArtifactRef): void {
    const e = this.ensure(ref);
    if (e) this.trim(e);
  }

  peek(ref: ArtifactRef, rect: Rect): void {
    const e = this.ensure(ref);
    if (!e) return;
    if (this.peeked && this.peeked !== e) this.endPeek(this.peeked);
    const p = e.placement;
    const from = p.kind === "tab" ? p : p.kind === "peek" ? p.from : null;
    e.placement = { kind: "peek", rect, from };
    this.peeked = e;
    void setZoom(e, true);
    this.raise(e);
    this.apply(e);
    syncOverlay(e);
    this.trim(e);
  }

  unpeek(): void {
    if (!this.peeked) return;
    this.endPeek(this.peeked);
    this.trim();
  }

  attach(tabKey: string, ref: ArtifactRef, rect: Rect): void {
    const e = this.ensure(ref);
    if (!e) return;
    for (const other of this.entries.values()) {
      if (other === e) continue;
      const p = other.placement;
      if (p.kind === "tab" && p.tabKey === tabKey) this.unplace(other);
      else if (p.kind === "peek" && p.from?.tabKey === tabKey) p.from = null;
    }
    const wasPeek = e.placement.kind === "peek";
    if (this.peeked === e) this.peeked = null;
    e.placement = { kind: "tab", tabKey, rect, visible: true };
    if (wasPeek) void setZoom(e, false);
    this.raise(e);
    this.apply(e);
    syncOverlay(e);
    if (wasPeek && e.stillDue) this.stillCapture.schedule(e);
    this.trim(e);
  }

  setBounds(tabKey: string, rect: Rect): void {
    const hit = this.tabPlace(tabKey);
    if (!hit) return;
    hit.place.rect = rect;
    this.apply(hit.e);
  }

  setVisible(tabKey: string, visible: boolean): void {
    const hit = this.tabPlace(tabKey);
    if (!hit) return;
    hit.place.visible = visible;
    if (visible) hit.e.lastUsed = Date.now();
    this.apply(hit.e);
  }

  detach(tabKey: string): void {
    const hit = this.tabPlace(tabKey);
    if (!hit) return;
    const p = hit.e.placement;
    if (p.kind === "peek") p.from = null;
    else this.unplace(hit.e);
    this.trim();
  }

  reload(slug: string): void {
    const e = this.entries.get(slug);
    if (!e) return;
    e.lastUsed = Date.now();
    void this.load(e, true);
  }

  still(ref: ArtifactRef): Promise<string | null> {
    return this.stills.read(ref.slug, ref.version);
  }

  state(slug: string): ViewState {
    return this.entries.get(slug)?.state ?? "idle";
  }

  // Re-apply every view's geometry (a controlled computer's view came or went).
  relayout(): void {
    for (const e of this.entries.values()) this.apply(e);
  }

  // A click on the peek's miniature (artifactOverlay preload's shield).
  overlayAction(sender: WebContents, action: unknown): void {
    const e = [...this.entries.values()].find((x) => x.view.webContents.id === sender.id);
    if (!e || e.placement.kind !== "peek") return;
    if (action === "open") this.send("eosArtifacts:action", { slug: e.slug, action: "open" });
    else if (action === "external") void shell.openExternal(artifactViewerUrl(e.slug));
  }

  disposeAll(): void {
    for (const e of [...this.entries.values()]) this.dispose(e, false);
    this.peeked = null;
  }

  // ---- pool ----------------------------------------------------------------

  // The views live in the main window; a new main window starts an empty pool.
  private window(): BrowserWindow | null {
    const win = this.deps.getWin();
    const live = win && !win.isDestroyed() ? win : null;
    if (live !== this.win) {
      this.disposeAll();
      this.win = live;
      if (live) {
        const relayout = (): void => { if (this.win === live) this.relayout(); };
        live.on("hide", relayout);
        live.on("show", relayout);
        live.on("minimize", relayout);
        live.on("restore", relayout);
        live.once("closed", () => {
          if (this.win !== live) return;
          this.disposeAll();
          this.win = null;
        });
      }
    }
    return this.win;
  }

  private ensure(ref: ArtifactRef): Entry | null {
    const win = this.window();
    if (!win) return null;
    const partition = this.deps.sessions.partitionFor(ref.loginId);
    const existing = this.entries.get(ref.slug);
    let e: Entry | null;
    if (existing && existing.partition === partition) {
      e = existing;
      e.ref = { ...e.ref, ...ref };
      // A newer version was published since this view loaded.
      if (ref.version && e.loadedVersion && ref.version !== e.loadedVersion) void this.load(e, true);
    } else if (existing) {
      e = this.recreate(existing, { ...existing.ref, ...ref }, partition);
    } else {
      e = this.create(win, ref, partition);
    }
    if (!e) return null;
    e.lastUsed = Date.now();
    return e;
  }

  private create(win: BrowserWindow, ref: ArtifactRef, partition: string): Entry {
    this.deps.sessions.session(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: this.deps.overlayPreload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A hidden page must still paint while it loads and until its still is taken (syncThrottle).
        backgroundThrottling: false,
      },
    });
    const e = newEntry(ref, partition, view);
    view.webContents.setAudioMuted(true);
    view.setVisible(false);
    view.setBounds(hiddenRect());
    win.contentView.addChildView(view);
    this.entries.set(ref.slug, e);
    wireView(e, {
      setState: (entry, state, error) => this.setState(entry, state, error),
      sendOverlay: syncOverlay,
    });
    void this.load(e);
    return e;
  }

  // The sign-in now lives in another partition: a fresh view there, in the old one's place.
  private recreate(old: Entry, ref: ArtifactRef, partition: string): Entry | null {
    const win = this.window();
    if (!win) return null;
    const placement = old.placement;
    const wasPeek = this.peeked === old;
    this.dispose(old, false);
    const e = this.create(win, ref, partition);
    e.placement = placement;
    if (wasPeek) {
      this.peeked = e;
      void setZoom(e, true);
    }
    if (placement.kind !== "none") this.raise(e);
    this.apply(e);
    return e;
  }

  private dispose(e: Entry, announce: boolean): void {
    if (e.disposed) return;
    e.disposed = true;
    for (const t of e.timers) clearTimeout(t);
    e.timers.clear();
    if (this.entries.get(e.slug) === e) this.entries.delete(e.slug);
    if (this.peeked === e) this.peeked = null;
    const wc = e.view.webContents;
    try { this.win?.contentView.removeChildView(e.view); } catch { /* window gone */ }
    try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch { /* already detached */ }
    try { wc.close(); } catch { /* already gone */ }
    if (announce) this.send("eosArtifacts:stateChanged", { slug: e.slug, state: "idle" });
  }

  // `keep` is the view the current call is about — never its own eviction.
  private trim(keep?: Entry): void {
    const items = [...this.entries.values()].map((e) => ({
      key: e.slug,
      placed: e.placement.kind !== "none" || e === keep,
      lastUsed: e.lastUsed,
    }));
    for (const slug of pickEvictions(items, POOL_CAP, Date.now(), IDLE_MS)) {
      const e = this.entries.get(slug);
      if (e) this.dispose(e, true);
    }
  }

  private tabPlace(tabKey: string): { e: Entry; place: TabPlace } | null {
    for (const e of this.entries.values()) {
      const p = e.placement;
      if (p.kind === "tab" && p.tabKey === tabKey) return { e, place: p };
      if (p.kind === "peek" && p.from?.tabKey === tabKey) return { e, place: p.from };
    }
    return null;
  }

  // ---- placement -----------------------------------------------------------

  private endPeek(e: Entry): void {
    if (this.peeked === e) this.peeked = null;
    const p = e.placement;
    if (p.kind !== "peek") return;
    e.placement = p.from ?? { kind: "none" };
    e.lastUsed = Date.now();
    void setZoom(e, false);
    this.apply(e);
    syncOverlay(e);
    if (e.stillDue) this.stillCapture.schedule(e);
  }

  private unplace(e: Entry): void {
    e.placement = { kind: "none" };
    e.lastUsed = Date.now();
    this.apply(e);
    syncOverlay(e);
    if (e.stillDue) this.stillCapture.schedule(e);
  }

  // Re-adding a child view moves it to the top of the window's view stack.
  private raise(e: Entry): void {
    const win = this.window();
    if (!win || this.deps.covered?.()) return;
    win.contentView.addChildView(e.view);
  }

  private apply(e: Entry): void {
    applyPlacement(e, {
      covered: () => this.deps.covered?.() ?? false,
      onScreen: () => {
        const win = this.win;
        return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
      },
    });
  }

  // ---- loading + state -----------------------------------------------------

  private async load(e: Entry, recapture = false): Promise<void> {
    if (e.disposed) return;
    const seq = ++e.seq;
    e.capturing = true;
    e.recapture = e.recapture || recapture;
    e.stillDue = false;
    e.loadedVersion = e.ref.version;
    if (!(await this.deps.sessions.signedIn(e.partition))) {
      if (e.seq === seq) this.setState(e, "signin");
      return;
    }
    if (e.disposed || e.seq !== seq) return;
    syncThrottle(e);
    this.setState(e, "loading");
    e.view.webContents.loadURL(artifactViewerUrl(e.slug)).catch(() => {
      // reported by did-fail-load or the redirect guard
    });
    // A subresource that never finishes holds back the load event: a page that
    // got as far as dom-ready is shown anyway.
    later(e, LOAD_TIMEOUT_MS, () => {
      if (e.seq !== seq || e.state !== "loading") return;
      if (e.domSeq === seq) this.setState(e, "ready");
      else this.setState(e, "error", "The artifact took too long to load");
    });
  }

  private setState(e: Entry, state: ViewState, error?: string): void {
    if (e.disposed) return;
    const err = state === "error" ? error ?? "The artifact didn't load" : undefined;
    if (e.state === state && e.error === err) return;
    e.state = state;
    e.error = err;
    if (state === "ready") void this.stillCapture.prepare(e);
    else if (state !== "loading") e.capturing = false;
    this.apply(e);
    this.send("eosArtifacts:stateChanged", err ? { slug: e.slug, state, error: err } : { slug: e.slug, state });
  }

  private resume(partition: string): void {
    for (const e of this.entries.values()) {
      if (e.partition === partition && e.state === "signin") void this.load(e);
    }
  }

  private signedOut(partition: string): void {
    for (const e of this.entries.values()) {
      if (e.partition !== partition) continue;
      e.seq++;
      this.setState(e, "signin");
      e.view.webContents.loadURL("about:blank").catch(() => {});
    }
  }

  private relink(loginId: string): void {
    const partition = this.deps.sessions.partitionFor(loginId);
    for (const e of [...this.entries.values()]) {
      if (e.ref.loginId === loginId && e.partition !== partition) this.recreate(e, e.ref, partition);
    }
  }

  // ---- renderer ------------------------------------------------------------

  private send(channel: string, payload: unknown): void {
    const win = this.win;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}
