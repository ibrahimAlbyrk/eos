import { WebContentsView, session as electronSession, app as electronApp, type BaseWindow } from "electron";
import { join } from "node:path";

// ViewManager — owns every embedded browser view (the app half of the embedded
// lane). One WebContentsView per tab, attached to the main window's contentView,
// positioned as a native layer over the React panel's placeholder rect. The
// renderer never touches a webContents: it reports geometry/visibility only, and
// all state-changing verbs flow renderer → daemon REST → RemoteBrowserEngine →
// this manager's driver (see driver.ts).
//
// Security (plan §C): each session gets an isolated persist: partition distinct
// from the eos:// app session; a deny-all permission handler (Electron auto-
// approves otherwise); popups denied and reopened as in-app tabs; navigation to
// privileged schemes blocked.

export interface TabHandle {
  tabId: string;
  sessionKey: string;
  view: WebContentsView;
  // webContents.debugger — the CDP door the driver drives (attached for life).
  dbg: Electron.Debugger;
  refs: Map<string, number>; // "@eN" -> backendNodeId; cleared on main-frame nav
  refCounter: number;
  device: "responsive" | "mobile" | "tablet";
}

// Size a background (hidden) view carries so its page keeps a real layout
// viewport — an agent driving a tab no human is watching still needs
// click/scroll/capture to work. A CDP Emulation.setDeviceMetricsOverride would be
// the headless way, but it segfaults V8's inspector on a WebContentsView, so the
// view's own (hidden) size is what gives the viewport instead.
const BG_SIZE = { width: 1280, height: 800 };

// Emulated CSS-px viewports for the device menu (mirrors driver DEVICE_PROFILES
// and the renderer's deviceViewport.js). Responsive has no fixed box — it tracks
// the panel — so it is absent. A device-sized view is centered in the panel rect
// (viewRectFor); the panel's own opaque background shows as the backdrop around
// it, so app content never bleeds through where the smaller view doesn't cover.
const DEVICE_VIEWPORT: Record<string, { width: number; height: number } | undefined> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
};

type Notify = (sessionKey: string, event: string, payload?: unknown) => void;

function partitionFor(sessionKey: string): string {
  return `persist:eos-browser-${sessionKey.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}

// Per-partition setup, installed exactly once per partition:
//  - Deny-all permission policy — Electron auto-approves camera/mic/geo/
//    notifications without a handler. Deny-by-default is the safe Stage-2
//    stance; an interactive per-site allow/deny prompt is a later addition
//    (plan I-7) — it would swap the callback(false) below for a native dialog.
//  - Downloads route to the user's Downloads dir (matches the app's saveFile
//    behavior), so a browser download lands somewhere predictable.
const configuredPartitions = new Set<string>();
function ensurePartitionSetup(partition: string): void {
  if (configuredPartitions.has(partition)) return;
  configuredPartitions.add(partition);
  const ses = electronSession.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (_e, item) => {
    try {
      item.setSavePath(join(electronApp.getPath("downloads"), item.getFilename()));
    } catch {
      // leave Electron's default (a save dialog) as the fallback
    }
  });
}

export class ViewManager {
  private win: BaseWindow;
  private notify: Notify;
  private tabs = new Map<string, TabHandle>();
  // How a popup (window.open / target=_blank) becomes a tab — set after the
  // driver exists (it owns openTab), so the daemon learns of the new tab too.
  private openTabForSession: ((sessionKey: string, url: string) => void) | null = null;
  // The view the panel is currently showing, and the last rect the renderer
  // reported for it — applied whenever either changes.
  private currentTabId: string | null = null;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = true;
  private overlay = false;

  constructor(deps: { win: BaseWindow; notify: Notify }) {
    this.win = deps.win;
    this.notify = deps.notify;
  }

  setOpenTab(fn: (sessionKey: string, url: string) => void): void {
    this.openTabForSession = fn;
  }

  get(tabId: string): TabHandle | undefined {
    return this.tabs.get(tabId);
  }

  mustTab(tabId: string): TabHandle {
    const t = this.tabs.get(tabId);
    if (!t) throw new Error(`unknown tab: ${tabId}`);
    return t;
  }

  tabsForSession(sessionKey: string): TabHandle[] {
    return [...this.tabs.values()].filter((t) => t.sessionKey === sessionKey);
  }

  // Create a view + attach its debugger, enable the CDP domains the verbs need,
  // and wire ref invalidation + tab-change events. The view starts hidden at
  // zero size; the renderer positions it via setActiveView/setBounds.
  createTab(tabId: string, sessionKey: string): TabHandle {
    const partition = partitionFor(sessionKey);
    ensurePartitionSetup(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false, // agent-driven tabs must keep timers/AX live when hidden
      },
    });
    const wc = view.webContents;
    // Popups → in-app tabs; never a real OS window.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.openTabForSession?.(sessionKey, url);
      return { action: "deny" };
    });
    // Fence privileged schemes only; arbitrary web navigation is allowed (the
    // agent's origin allowlist stays daemon-side in BrowserService).
    wc.on("will-navigate", (e, url) => {
      if (/^(eos|file|chrome|devtools):/i.test(url)) e.preventDefault();
    });
    wc.on("will-redirect", (e, url) => {
      if (/^(eos|file|chrome|devtools):/i.test(url)) e.preventDefault();
    });

    const dbg = wc.debugger;
    try {
      dbg.attach("1.3");
    } catch (e) {
      console.error("[eos-browser] debugger.attach failed:", e instanceof Error ? e.message : String(e));
    }
    const handle: TabHandle = { tabId, sessionKey, view, dbg, refs: new Map(), refCounter: 0, device: "responsive" };
    void dbg.sendCommand("Page.enable").catch(() => {});
    void dbg.sendCommand("DOM.enable").catch(() => {});
    void dbg.sendCommand("Accessibility.enable").catch(() => {});
    void dbg.sendCommand("Runtime.enable").catch(() => {});
    // A hidden/occluded WebContentsView otherwise DEFERS renderer-initiated
    // navigation (link clicks, location.assign, form submits) until it's shown —
    // so an agent clicking a link in a tab no human is watching would stall.
    // Emulating focus keeps the page "active" so those navigations proceed.
    void dbg.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    // Ref invalidation: a main-frame navigation recycles backendNodeIds, so every
    // ref minted before it is a landmine — clear the map (same signal the headless
    // adapter uses).
    dbg.on("message", (_e, method, params) => {
      if (method === "Page.frameNavigated" && !(params as { frame?: { parentId?: string } })?.frame?.parentId) {
        handle.refs.clear();
      }
    });
    // Native lifecycle → tabsChanged so the daemon re-reads listTabs (URL bar,
    // Back/Forward, loading spinner).
    const changed = (): void => this.notify(sessionKey, "tabsChanged");
    wc.on("page-title-updated", changed);
    wc.on("did-navigate", () => { handle.refs.clear(); changed(); });
    wc.on("did-navigate-in-page", changed);
    wc.on("did-start-loading", changed);
    wc.on("did-stop-loading", changed);
    wc.on("render-process-gone", () => this.notify(sessionKey, "tabCrashed", { tabId }));

    this.tabs.set(tabId, handle);
    view.setBorderRadius?.(0);
    // Attach + give the view a real (hidden) size BEFORE any CDP viewport
    // override — issuing Emulation.setDeviceMetricsOverride on an unattached view
    // segfaults the inspector. A fresh tab is a background view: sized + hidden +
    // an imposed viewport so an agent can drive it before any human opens it.
    this.win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: BG_SIZE.width, height: BG_SIZE.height });
    view.setVisible(false);
    return handle;
  }

  removeTab(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    this.tabs.delete(tabId);
    if (this.currentTabId === tabId) this.currentTabId = null;
    try { t.dbg.detach(); } catch { /* already detached */ }
    try { this.win.contentView.removeChildView(t.view); } catch { /* not attached */ }
    try { t.view.webContents.close(); } catch { /* already gone */ }
  }

  disposeSession(sessionKey: string): void {
    for (const t of this.tabsForSession(sessionKey)) this.removeTab(t.tabId);
  }

  disposeAll(): void {
    for (const tabId of [...this.tabs.keys()]) this.removeTab(tabId);
  }

  // ---- geometry / z-order (driven by the renderer over preload IPC) ---------

  // Show tab `tabId` of `sessionKey` in the panel region: bring it to the top of
  // the native child-view stack, hide its siblings, and position it. Reports the
  // active tab back to the daemon so the omitted-tabId "the page the human sees"
  // resolution stays exact.
  setActiveView(sessionKey: string, tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    for (const other of this.tabsForSession(sessionKey)) {
      if (other.tabId !== tabId) other.view.setVisible(false);
    }
    this.currentTabId = tabId;
    this.win.contentView.addChildView(t.view); // re-add == move to top
    this.applyGeometry();
    this.notify(sessionKey, "activeTabChanged", { tabId });
  }

  // Record the tab's emulated device and re-center the view. Called by the driver
  // when it applies CDP device metrics, so the visible view resizes to the device
  // rect and the panel backdrop shows around it (FIX 3: no more top-left anchor).
  setDevice(tabId: string, device: TabHandle["device"]): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.device = device;
    if (this.currentTabId === tabId) this.applyGeometry();
  }

  setBounds(rect: { x: number; y: number; width: number; height: number }): void {
    this.bounds = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(0, Math.round(rect.width)),
      height: Math.max(0, Math.round(rect.height)),
    };
    this.applyGeometry();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyGeometry();
  }

  // An overlay (modal/menu/palette) must draw ABOVE the native layer, which it
  // cannot in the DOM — so hide the view for the overlay's lifetime and mute it.
  setOverlay(open: boolean): void {
    this.overlay = open;
    this.applyGeometry();
  }

  private applyGeometry(): void {
    const t = this.currentTabId ? this.tabs.get(this.currentTabId) : null;
    if (!t) return;
    const show = this.visible && !this.overlay && this.bounds.width > 0 && this.bounds.height > 0;
    t.view.setVisible(show);
    // Silence a view the human can't see (native equivalent of the headless
    // "silence when unviewed").
    try { t.view.webContents.setAudioMuted(!show); } catch { /* closing */ }
    // A shown view tracks the panel rect (device-emulated tabs get a centered
    // device-sized rect); a hidden one keeps a real size (not zero) so its page
    // retains a layout viewport for agent geometry ops.
    t.view.setBounds(show ? this.viewRectFor(t) : { x: 0, y: 0, width: BG_SIZE.width, height: BG_SIZE.height });
  }

  // The on-screen rect for a shown view. Responsive fills the panel; a device
  // emulates a fixed CSS-px box, centered inside the panel rect and clamped to it
  // (a device taller/wider than the panel is bounded, never overflowing into
  // adjacent UI). Centering is what fixes the top-left anchor bug (FIX 3).
  private viewRectFor(t: TabHandle): { x: number; y: number; width: number; height: number } {
    const dev = DEVICE_VIEWPORT[t.device];
    if (!dev) return this.bounds;
    const width = Math.min(dev.width, this.bounds.width);
    const height = Math.min(dev.height, this.bounds.height);
    return {
      x: this.bounds.x + Math.round((this.bounds.width - width) / 2),
      y: this.bounds.y + Math.round((this.bounds.height - height) / 2),
      width,
      height,
    };
  }
}
