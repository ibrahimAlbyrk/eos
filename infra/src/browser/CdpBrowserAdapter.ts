// CdpBrowserAdapter — the BrowserEngine port over one supervised Google Chrome
// child, driven with raw CDP through --remote-debugging-pipe (cdpPipe.ts). This
// is the HEADLESS FALLBACK: used when no Electron app has registered as browser
// host (CI, cron, `eos start` with no GUI). It implements only the AUTOMATION
// half of the port — the human sees the native embedded WebContentsView in the
// app, never a screencast, so no frame streaming/input-forwarding lives here.
//
// Ref lifecycle (the load-bearing detail): `@eN` refs are minted per tab by
// snapshot/find/elementAt, backed by backendNodeId, and the map is cleared on
// every main-frame navigation — a stale ref raises StaleRefError instead of
// silently acting on a recycled node. The per-tab counter never resets, so a
// ref string is never reused within a tab's life.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type {
  BrowserActVerb,
  BrowserEngine,
  BrowserEngineTabInfo,
  BrowserGetWhat,
  BrowserNavigateAction,
  BrowserScrollDirection,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
} from "../../../core/src/ports/BrowserEngine.ts";
import { StaleRefError } from "../../../core/src/ports/BrowserEngine.ts";
import type { BrowserDevice, BrowserElement } from "../../../contracts/src/browser.ts";
import { CdpPipeClient } from "./cdpPipe.ts";
import { formatAXTree, roleOf, statesOf, type AXNodeLike } from "./snapshotFormatter.ts";
import { audioGuardSource } from "./audioGuard.ts";
import { parseChord } from "./keys.ts";

const DEFAULT_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

// Engine-default viewport (the "responsive" device profile). Frames stream at
// maxWidth<=1024, so 1280x800 CSS at dsf2 caps to 1024x640.
const VIEWPORT = { width: 1280, height: 800 };

// Device emulation profiles (plan §3.1). The mobile/tablet UAs are the exact
// strings the spike verified produce the genuine mobile DOM (m.youtube.com).
const DEVICE_PROFILES = {
  responsive: { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false, touch: false, userAgent: null as string | null, platform: null as string | null },
  mobile: {
    width: 375, height: 812, deviceScaleFactor: 3, mobile: true, touch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
  },
  tablet: {
    width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, touch: true,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    platform: "iPad",
  },
} as const;

// Full-page capture limits: a clip taller than 8192 device px wedges Chrome
// (spike §4a — it hangs, then Target.createTarget stops responding), so tiles
// stay under that and the stitched canvas stays under Chrome's max canvas
// dimension (32767).
const MAX_TILE_DEVICE_PX = 8192;
const MAX_STITCHED_DEVICE_PX = 32000;

const FIND_MATCH_CAP = 10;
const TEXT_CAP = 40_000;

// LAUNCH MODE — every launch flag lives in this one function. AUDIO IS IN
// SCOPE: Chrome plays straight to the system output device (never pass
// --mute-audio); only pictures travel over CDP. The audio spike CONFIRMED
// --headless=new reaches CoreAudio on this platform, so headless is final —
// the headed off-screen fallback is dead (macOS clamps --window-position back
// on-screen, steals focus, appears in the Dock; do not rebuild it).
export function chromeLaunchArgs(profileDir: string): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    // Mandatory: the screencast ignores emulated deviceScaleFactor — without
    // this flag every frame arrives 1x and maxWidth cannot fix it (spike §0a).
    "--force-device-scale-factor=2",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // Mandatory for audio: without it play() rejects with NotAllowedError and
    // nothing ever makes sound (audio spike).
    "--autoplay-policy=no-user-gesture-required",
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  ];
}

interface Tab {
  tabId: string;
  targetId: string;
  sessionId: string;
  loading: boolean;
  refs: Map<string, number>; // "@eN" -> backendNodeId; cleared on navigation
  refCounter: number;
  pendingHistoryReset: boolean; // erase the about:blank bootstrap on first real commit
  userMuted: boolean;
  device: BrowserDevice;
  viewport: { width: number; height: number };
  audioGuardId: string | null; // addScriptToEvaluateOnNewDocument identifier
  // Favicon cache: resolved once per page URL (it rides every tabs poll and
  // every browser:tabs event, so it must never re-fetch per call).
  faviconDataUri: string | null;
  faviconForUrl: string | null;
  faviconFetching: boolean;
}

// Favicon caps: raw icon bytes beyond this are skipped (the data URI rides
// every tabs payload), fetch is short-fused.
const FAVICON_MAX_BYTES = 16 * 1024;
const FAVICON_FETCH_TIMEOUT_MS = 3000;

export class CdpBrowserAdapter implements BrowserEngine {
  private chromePath: string | null;
  private profileDir: string;
  private notify: (msg: string, meta?: Record<string, unknown>) => void;
  private child: ChildProcess | null = null;
  private cdp: CdpPipeClient | null = null;
  private tabs = new Map<string, Tab>();
  private exitCbs: Array<(info: { code: number | null }) => void> = [];
  private tabsChangedCbs: Array<() => void> = [];
  private keepAliveSessionId: string | null = null;
  private defaultUserAgent: string | null = null;
  // Only ONE target is foreground, and a BACKGROUND TARGET EMITS ZERO
  // SCREENCAST FRAMES (audio spike: 0 frames in 10s while audio kept playing)
  // — so the adapter tracks the foreground and every screencast/capture puts
  // its tab there first. The keep-alive target has no Tab entry and is never
  // brought to front.
  private foregroundTabId: string | null = null;

  constructor(deps: { chromePath: string | null; profileDir: string; notify?: (msg: string, meta?: Record<string, unknown>) => void }) {
    this.chromePath = deps.chromePath;
    this.profileDir = deps.profileDir;
    this.notify = deps.notify ?? (() => {});
  }

  binaryPath(): string | null {
    if (this.chromePath) return existsSync(this.chromePath) ? this.chromePath : null;
    for (const p of DEFAULT_CHROME_PATHS) if (existsSync(p)) return p;
    return null;
  }

  isRunning(): boolean {
    return this.cdp != null && !this.cdp.isClosed();
  }

  // The foreground tab, iff it is still a live tab — the omitted-tabId default.
  // foregroundTabId is set by openTab/bringToFront (a subscribe brings its tab
  // to front) and cleared on close/crash; guard against a stale id anyway so a
  // just-closed tab never resolves as active.
  activeTabId(): string | null {
    return this.foregroundTabId && this.tabs.has(this.foregroundTabId) ? this.foregroundTabId : null;
  }

  onExit(cb: (info: { code: number | null }) => void): void {
    this.exitCbs.push(cb);
  }

  onTabsChanged(cb: () => void): void {
    this.tabsChangedCbs.push(cb);
  }

  private notifyTabsChanged(): void {
    for (const cb of this.tabsChangedCbs) cb();
  }

  async launch(): Promise<void> {
    if (this.isRunning()) return;
    const bin = this.binaryPath();
    if (!bin) throw new Error("no Chrome binary found");
    mkdirSync(this.profileDir, { recursive: true });
    // fd 3 = Chrome reads CDP commands, fd 4 = Chrome writes CDP messages.
    const child = spawn(bin, chromeLaunchArgs(this.profileDir), {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    const cdp = new CdpPipeClient(child.stdio[3] as Writable, child.stdio[4] as Readable);
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.cdp = null;
      this.tabs.clear();
      this.foregroundTabId = null;
      for (const cb of this.exitCbs) cb({ code });
    });
    // Loading state per tab — drives BrowserTab.loading (setLoading notifies).
    cdp.on("Page.frameStartedLoading", (_p, sessionId) => this.setLoading(sessionId, true));
    cdp.on("Page.frameStoppedLoading", (_p, sessionId) => this.setLoading(sessionId, false));
    // URL/title changes that never pass through the service (link clicks, SPA
    // routing, late <title> writes) — Target discovery makes them events.
    cdp.on("Target.targetInfoChanged", (params) => {
      const info = (params as { targetInfo?: { targetId?: string } }).targetInfo;
      if (!info?.targetId) return;
      for (const tab of this.tabs.values()) {
        if (tab.targetId === info.targetId) this.notifyTabsChanged();
      }
    });
    // Audible edges pushed by the injected audio guard (1s in-page poll → the
    // __eosNotify binding) — no daemon-side per-tab polling.
    cdp.on("Runtime.bindingCalled", (params) => {
      if ((params as { name?: string }).name === "__eosNotify") this.notifyTabsChanged();
    });
    // Ref invalidation: a main-frame navigation recycles backendNodeIds, so
    // every ref minted before it is now a landmine — clear the map. The same
    // edge erases the about:blank bootstrap entry from history (one-shot per
    // tab), so the panel's Back never lands on the injection-seam blank page.
    cdp.on("Page.frameNavigated", (params, sessionId) => {
      const frame = (params as { frame?: { parentId?: string; url?: string } }).frame;
      if (frame?.parentId) return; // subframe — main-document refs still valid
      for (const tab of this.tabs.values()) {
        if (tab.sessionId !== sessionId) continue;
        tab.refs.clear();
        if (tab.pendingHistoryReset && frame?.url && frame.url !== "about:blank") {
          tab.pendingHistoryReset = false;
          void this.cdp?.send("Page.resetNavigationHistory", {}, sessionId).catch(() => {});
        }
      }
    });
    this.child = child;
    this.cdp = cdp;
    // Handshake: proves the pipe session is really up before we report running.
    const version = (await cdp.send("Browser.getVersion")) as { userAgent?: string };
    // The real UA minus the headless tell — what "responsive" restores after
    // a mobile/tablet emulation stint.
    this.defaultUserAgent = (version.userAgent ?? "").replace("HeadlessChrome", "Chrome") || null;
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    // Keep-alive target: headless Chrome EXITS when its last target closes
    // (audio spike), so closing the panel's last tab would silently kill the
    // browser and read as a crash. This target lives for the session and never
    // enters the tabs map, so it is invisible to listTabs. It also hosts the
    // full-page capture stitcher (an off-DOM canvas needs *some* document).
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    this.keepAliveSessionId = sessionId;
  }

  async openTab(url: string): Promise<string> {
    const cdp = this.mustCdp();
    // Start at about:blank so the audio guard is registered BEFORE the first
    // real document — late injection provably fails (audio spike).
    const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("DOM.enable", {}, sessionId);
    await cdp.send("Accessibility.enable", {}, sessionId);
    const { identifier } = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: audioGuardSource(false), runImmediately: true }, sessionId)) as { identifier: string };
    // Deterministic CSS viewport so headless capture/scroll have a real box.
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 2, mobile: false }, sessionId);
    const tabId = `bt-${randomBytes(6).toString("hex")}`;
    // A blank tab (no real URL) stays on the createTarget's about:blank: no
    // second navigate — that would add a duplicate history entry (lighting
    // "Back") and mark the tab loading forever. It navigates only when the human
    // types a URL. A real URL keeps the bootstrap-then-navigate flow so the
    // audio guard is live before the first real document.
    const willNavigate = !!url && url !== "about:blank";
    this.tabs.set(tabId, {
      tabId, targetId, sessionId, loading: willNavigate,
      refs: new Map(), refCounter: 0, pendingHistoryReset: true,
      userMuted: false,
      device: "responsive", viewport: { ...VIEWPORT }, audioGuardId: identifier,
      faviconDataUri: null, faviconForUrl: null, faviconFetching: false,
    });
    if (willNavigate) await cdp.send("Page.navigate", { url }, sessionId);
    // The most-recently-opened tab is the engine's foreground — the omitted-tabId
    // "active tab" the agent resolves to in the headless lane.
    this.foregroundTabId = tabId;
    return tabId;
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.mustTab(tabId);
    this.tabs.delete(tabId);
    if (this.foregroundTabId === tabId) this.foregroundTabId = null;
    try {
      await this.mustCdp().send("Target.closeTarget", { targetId: tab.targetId });
    } catch {
      // target already gone (crash/teardown race) — the map entry is dropped
    }
  }

  async listTabs(): Promise<BrowserEngineTabInfo[]> {
    const cdp = this.mustCdp();
    const out: BrowserEngineTabInfo[] = [];
    for (const tab of this.tabs.values()) {
      const info = (await cdp.send("Target.getTargetInfo", { targetId: tab.targetId })) as {
        targetInfo: { url: string; title: string };
      };
      const hist = (await cdp.send("Page.getNavigationHistory", {}, tab.sessionId)) as {
        currentIndex: number;
        entries: unknown[];
      };
      out.push({
        tabId: tab.tabId,
        url: info.targetInfo.url,
        title: info.targetInfo.title,
        loading: tab.loading,
        canGoBack: hist.currentIndex > 0,
        canGoForward: hist.currentIndex < hist.entries.length - 1,
        audible: await this.isAudible(tab),
        muted: tab.userMuted,
        faviconDataUri: tab.faviconDataUri,
      });
    }
    return out;
  }

  async navigate(tabId: string, action: BrowserNavigateAction, url?: string): Promise<void> {
    const tab = this.mustTab(tabId);
    const cdp = this.mustCdp();
    if (action === "url") {
      if (!url) throw new Error("navigate action 'url' requires a url");
      await cdp.send("Page.navigate", { url }, tab.sessionId);
      return;
    }
    if (action === "reload") {
      await cdp.send("Page.reload", {}, tab.sessionId);
      return;
    }
    const hist = (await cdp.send("Page.getNavigationHistory", {}, tab.sessionId)) as {
      currentIndex: number;
      entries: Array<{ id: number }>;
    };
    const target = hist.entries[hist.currentIndex + (action === "back" ? -1 : 1)];
    if (!target) return; // nothing to go to — a no-op, not an error
    await cdp.send("Page.navigateToHistoryEntry", { entryId: target.id }, tab.sessionId);
  }

  // Trusted mouse dispatch (pages see isTrusted:true) — the internal primitive
  // for click/hover/scroll. Not a port method; the human uses the native
  // embedded view, so there is no human-input forwarding here.
  private async mouse(tab: Tab, p: { type: string; x: number; y: number; button?: string; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number }): Promise<void> {
    await this.mustCdp().send(
      "Input.dispatchMouseEvent",
      {
        type: p.type,
        x: p.x,
        y: p.y,
        button: p.button ?? "none",
        buttons: p.buttons ?? 0,
        clickCount: p.clickCount ?? 0,
        deltaX: p.deltaX ?? 0,
        deltaY: p.deltaY ?? 0,
        modifiers: 0,
      },
      tab.sessionId,
    );
  }

  // ---- snapshot / find ------------------------------------------------------

  async snapshot(tabId: string, opts: BrowserSnapshotOptions): Promise<BrowserSnapshotResult> {
    const tab = this.mustTab(tabId);
    const cdp = this.mustCdp();
    let rootBackendNodeId: number | undefined;
    if (opts.selector) {
      rootBackendNodeId = await this.backendNodeForSelector(tab, opts.selector);
    }
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree", {}, tab.sessionId)) as { nodes: AXNodeLike[] };
    // A fresh snapshot supersedes all earlier refs; the counter continues so
    // an old "@eN" can never silently alias a new node — it just goes stale.
    tab.refs.clear();
    const result = formatAXTree(nodes, {
      interactiveOnly: opts.interactiveOnly,
      depth: opts.depth,
      rootBackendNodeId,
      refStart: tab.refCounter,
    });
    tab.refCounter = result.nextRefIndex;
    for (const [ref, backendNodeId] of result.refs) tab.refs.set(ref, backendNodeId);
    const info = (await cdp.send("Target.getTargetInfo", { targetId: tab.targetId })) as { targetInfo: { url: string } };
    return { url: info.targetInfo.url, snapshot: result.text };
  }

  async find(tabId: string, query: string): Promise<BrowserElement[]> {
    const tab = this.mustTab(tabId);
    const cdp = this.mustCdp();
    const reMatch = query.match(/^\/(.+)\/([a-z]*)$/);
    const test = reMatch
      ? (s: string) => new RegExp(reMatch[1], reMatch[2].includes("i") ? reMatch[2] : reMatch[2] + "i").test(s)
      : (s: string) => s.toLowerCase().includes(query.toLowerCase());
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree", {}, tab.sessionId)) as { nodes: AXNodeLike[] };
    const out: BrowserElement[] = [];
    for (const node of nodes) {
      if (out.length >= FIND_MATCH_CAP) break;
      if (node.ignored || node.backendDOMNodeId == null) continue;
      const role = roleOf(node);
      if (role === "statictext" || role === "inlinetextbox" || role === "rootwebarea") continue;
      const name = String(node.name?.value ?? "");
      if (!name || !test(name)) continue;
      const el = await this.elementFromAXNode(tab, node).catch(() => null);
      if (el) out.push(el);
    }
    return out;
  }

  // ---- act verbs ------------------------------------------------------------

  async act(tabId: string, ref: string, verb: BrowserActVerb): Promise<void> {
    const tab = this.mustTab(tabId);
    const backendNodeId = this.resolveRef(tab, ref);
    if (verb === "focus") {
      await this.mustCdp().send("DOM.focus", { backendNodeId }, tab.sessionId);
      return;
    }
    if (verb === "check" || verb === "uncheck") {
      const checked = await this.callOnNode<boolean>(tab, backendNodeId, "function(){ return !!this.checked }");
      if (checked === (verb === "check")) return; // already in the desired state
      await this.trustedClick(tab, backendNodeId);
      return;
    }
    if (verb === "hover") {
      const { x, y } = await this.centerOf(tab, backendNodeId);
      await this.mouse(tab, { type: "mouseMoved", x, y, button: "none" });
      return;
    }
    await this.trustedClick(tab, backendNodeId);
  }

  async typeText(tabId: string, ref: string, text: string, submit: boolean): Promise<void> {
    const tab = this.mustTab(tabId);
    const backendNodeId = this.resolveRef(tab, ref);
    await this.mustCdp().send("DOM.focus", { backendNodeId }, tab.sessionId);
    // Replace, don't append: select the current content so insertText lands
    // over it (works for inputs, textareas and contenteditable).
    await this.callOnNode(tab, backendNodeId, `function(){
      if (this.select) this.select();
      else if (this.isContentEditable) {
        const r = document.createRange(); r.selectNodeContents(this);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    }`);
    await this.mustCdp().send("Input.insertText", { text }, tab.sessionId);
    if (submit) await this.press(tabId, "Enter");
  }

  async press(tabId: string, key: string): Promise<void> {
    const tab = this.mustTab(tabId);
    const cdp = this.mustCdp();
    const chord = parseChord(key);
    const base = {
      key: chord.key,
      code: chord.code,
      modifiers: chord.modifiers,
      windowsVirtualKeyCode: chord.windowsVirtualKeyCode,
      nativeVirtualKeyCode: chord.windowsVirtualKeyCode,
    };
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: chord.text ? "keyDown" : "rawKeyDown", text: chord.text, unmodifiedText: chord.text }, tab.sessionId);
    await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }, tab.sessionId);
  }

  async scroll(tabId: string, direction: BrowserScrollDirection, ref?: string): Promise<void> {
    const tab = this.mustTab(tabId);
    if (ref) {
      const backendNodeId = this.resolveRef(tab, ref);
      await this.callOnNode(tab, backendNodeId, `function(){
        const d = ${JSON.stringify(direction)};
        if (d === "top") this.scrollTo(0, 0);
        else if (d === "bottom") this.scrollTo(0, this.scrollHeight);
        else this.scrollBy(0, (d === "up" ? -0.8 : 0.8) * this.clientHeight);
      }`);
      return;
    }
    if (direction === "top" || direction === "bottom") {
      await this.evaluate(tab, direction === "top" ? "window.scrollTo(0, 0)" : "window.scrollTo(0, document.body.scrollHeight)");
      return;
    }
    // Trusted wheel at the viewport centre (DOM sign convention: +deltaY down).
    const { width, height } = tab.viewport;
    await this.mouse(tab, {
      type: "mouseWheel", x: Math.round(width / 2), y: Math.round(height / 2),
      button: "none", deltaX: 0, deltaY: (direction === "up" ? -0.8 : 0.8) * height,
    });
  }

  // ---- reads ----------------------------------------------------------------

  async get(tabId: string, what: BrowserGetWhat, ref?: string): Promise<string> {
    const tab = this.mustTab(tabId);
    const cdp = this.mustCdp();
    if (what === "url" || what === "title") {
      const info = (await cdp.send("Target.getTargetInfo", { targetId: tab.targetId })) as { targetInfo: { url: string; title: string } };
      return what === "url" ? info.targetInfo.url : info.targetInfo.title;
    }
    if (what === "text") {
      if (!ref) {
        return (await this.evaluate<string>(tab, `document.body ? document.body.innerText.slice(0, ${TEXT_CAP}) : ""`)) ?? "";
      }
      const backendNodeId = this.resolveRef(tab, ref);
      return (await this.callOnNode<string>(tab, backendNodeId, `function(){ return String(this.innerText ?? this.textContent ?? "").slice(0, ${TEXT_CAP}) }`)) ?? "";
    }
    if (!ref) throw new Error("get 'value' requires a ref");
    const backendNodeId = this.resolveRef(tab, ref);
    return (await this.callOnNode<string>(tab, backendNodeId, `function(){
      if (this.type === "password") return "[redacted]";
      return String(this.value ?? "");
    }`)) ?? "";
  }

  // ---- capture --------------------------------------------------------------

  // JPEG only — png hangs forever on live pages (spike §4a). Full page clamps
  // each clip to 8192 device px and stitches tiles in the keep-alive document (no
  // image lib in Node needed). A non-foreground headless target can't be
  // captured, so flip it to front, shoot, then restore the previous foreground.
  async capture(tabId: string, fullPage: boolean): Promise<Uint8Array> {
    const tab = this.mustTab(tabId);
    const prevForegroundId = this.foregroundTabId;
    const flip = prevForegroundId !== tabId;
    if (flip) await this.bringToFront(tab);
    try {
      return await this.captureForeground(tab, fullPage);
    } finally {
      if (flip && prevForegroundId) {
        const prev = this.tabs.get(prevForegroundId);
        if (prev) await this.bringToFront(prev);
      }
    }
  }

  private async captureForeground(tab: Tab, fullPage: boolean): Promise<Uint8Array> {
    const cdp = this.mustCdp();
    if (!fullPage) {
      const shot = (await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }, tab.sessionId)) as { data: string };
      return Buffer.from(shot.data, "base64");
    }
    const metrics = (await cdp.send("Page.getLayoutMetrics", {}, tab.sessionId)) as {
      cssContentSize: { width: number; height: number };
    };
    const dsf = DEVICE_PROFILES[tab.device].deviceScaleFactor;
    const width = Math.min(metrics.cssContentSize.width, tab.viewport.width);
    const tileCss = Math.floor(MAX_TILE_DEVICE_PX / dsf);
    const totalCss = Math.min(metrics.cssContentSize.height, Math.floor(MAX_STITCHED_DEVICE_PX / dsf));
    const tiles: string[] = [];
    for (let y = 0; y < totalCss; y += tileCss) {
      const h = Math.min(tileCss, totalCss - y);
      const shot = (await cdp.send("Page.captureScreenshot", {
        format: "jpeg", quality: 80, captureBeyondViewport: true,
        clip: { x: 0, y, width, height: h, scale: 1 },
      }, tab.sessionId)) as { data: string };
      tiles.push(shot.data);
    }
    if (tiles.length === 1) return Buffer.from(tiles[0], "base64");
    return this.stitchTiles(tiles);
  }

  private async stitchTiles(tiles: string[]): Promise<Uint8Array> {
    const cdp = this.mustCdp();
    if (!this.keepAliveSessionId) throw new Error("no stitcher document");
    const win = (await cdp.send("Runtime.evaluate", { expression: "window" }, this.keepAliveSessionId)) as { result: { objectId: string } };
    const stitched = (await cdp.send("Runtime.callFunctionOn", {
      objectId: win.result.objectId,
      functionDeclaration: `async function(tiles) {
        const imgs = await Promise.all(tiles.map((t) => new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error("tile decode failed"));
          i.src = "data:image/jpeg;base64," + t;
        })));
        const canvas = document.createElement("canvas");
        canvas.width = imgs[0].width;
        canvas.height = imgs.reduce((a, i) => a + i.height, 0);
        const ctx = canvas.getContext("2d");
        let y = 0;
        for (const img of imgs) { ctx.drawImage(img, 0, y); y += img.height; }
        return canvas.toDataURL("image/jpeg", 0.8).split(",")[1];
      }`,
      arguments: [{ value: tiles }],
      awaitPromise: true,
      returnByValue: true,
    }, this.keepAliveSessionId)) as { result: { value: string } };
    return Buffer.from(stitched.result.value, "base64");
  }

  // ---- device emulation ------------------------------------------------------

  async setDevice(tabId: string, device: BrowserDevice): Promise<void> {
    const tab = this.mustTab(tabId);
    const cdp = this.mustCdp();
    const p = DEVICE_PROFILES[device];
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: p.width, height: p.height, deviceScaleFactor: p.deviceScaleFactor, mobile: p.mobile,
    }, tab.sessionId);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: p.touch, maxTouchPoints: 5 }, tab.sessionId);
    await cdp.send("Emulation.setEmitTouchEventsForMouse", { enabled: p.touch, configuration: "mobile" }, tab.sessionId);
    const userAgent = p.userAgent ?? this.defaultUserAgent;
    if (userAgent) {
      await cdp.send("Emulation.setUserAgentOverride", { userAgent, ...(p.platform ? { platform: p.platform } : {}) }, tab.sessionId);
    }
    tab.device = device;
    tab.viewport = { width: p.width, height: p.height };
    // The UA only takes effect on the next document — reload so "Mobile"
    // genuinely produces the mobile DOM (spike §5). frameNavigated clears refs.
    await cdp.send("Page.reload", {}, tab.sessionId);
  }

  // ---- element picker --------------------------------------------------------

  async elementAt(tabId: string, x: number, y: number): Promise<BrowserElement> {
    const tab = this.mustTab(tabId);
    const cdp = this.mustCdp();
    const hit = (await cdp.send("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false }, tab.sessionId)) as { backendNodeId: number };
    const ax = (await cdp.send("Accessibility.getPartialAXTree", { backendNodeId: hit.backendNodeId, fetchRelatives: false }, tab.sessionId)) as { nodes: AXNodeLike[] };
    const node: AXNodeLike = ax.nodes[0] ?? { nodeId: "0", backendDOMNodeId: hit.backendNodeId };
    return this.buildElement(tab, hit.backendNodeId, node);
  }

  private async elementFromAXNode(tab: Tab, node: AXNodeLike): Promise<BrowserElement> {
    return this.buildElement(tab, node.backendDOMNodeId!, node);
  }

  // The minimal payload (~40-80 tokens): never markup, password values
  // redacted, `locator` durable across snapshots.
  private async buildElement(tab: Tab, backendNodeId: number, ax: AXNodeLike): Promise<BrowserElement> {
    const cdp = this.mustCdp();
    const desc = (await cdp.send("DOM.describeNode", { backendNodeId }, tab.sessionId)) as {
      node: { nodeName: string; attributes?: string[] };
    };
    const tag = desc.node.nodeName.toLowerCase();
    const box = await this.boxOf(tab, backendNodeId);
    const role = roleOf(ax) || tag;
    const name = String(ax.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    const states = statesOf(ax);
    const attrs = new Map<string, string>();
    const list = desc.node.attributes ?? [];
    for (let i = 0; i + 1 < list.length; i += 2) attrs.set(list[i], list[i + 1]);
    tab.refCounter += 1;
    const ref = `@e${tab.refCounter}`;
    tab.refs.set(ref, backendNodeId);
    let value: string | undefined;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      // Password values never leave the daemon.
      value = attrs.get("type") === "password"
        ? undefined
        : (await this.callOnNode<string>(tab, backendNodeId, "function(){ return String(this.value ?? \"\") }").catch(() => "")) || undefined;
    }
    const locator = name
      ? `role=${role}[name=${JSON.stringify(name)}]`
      : attrs.get("id")
        ? `#${attrs.get("id")}`
        : tag;
    return {
      ref, tag, role, name, box,
      focusable: (ax.properties ?? []).some((p) => p.name.toLowerCase() === "focusable" && p.value?.value === true),
      ...(states.length ? { state: states } : {}),
      ...(value !== undefined ? { value: value.slice(0, 100) } : {}),
      locator,
    };
  }

  // ---- wait probes -----------------------------------------------------------

  async textPresent(tabId: string, text: string): Promise<boolean> {
    const tab = this.mustTab(tabId);
    const hit = await this.evaluate<boolean>(tab, `!!document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`);
    return hit === true;
  }

  async refVisible(tabId: string, ref: string): Promise<boolean> {
    const tab = this.mustTab(tabId);
    const backendNodeId = this.resolveRef(tab, ref);
    try {
      await this.boxOf(tab, backendNodeId);
      return true;
    } catch {
      return false;
    }
  }

  // ---- audio -----------------------------------------------------------------

  // User-level mute (the browser_mute tool). The injected guard flips the page's
  // audio and reports audibility back over the __eosNotify binding.
  async setMuted(tabId: string, muted: boolean): Promise<void> {
    const tab = this.mustTab(tabId);
    tab.userMuted = muted;
    await this.applyForceMuted(tab);
  }

  private async applyForceMuted(tab: Tab): Promise<void> {
    const cdp = this.mustCdp();
    const effective = tab.userMuted;
    // Re-register the guard with the new initial state so documents loaded
    // AFTER this call (navigations) inherit it, then flip the live one.
    if (tab.audioGuardId) {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: tab.audioGuardId }, tab.sessionId).catch(() => {});
    }
    const { identifier } = (await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: audioGuardSource(effective) }, tab.sessionId)) as { identifier: string };
    tab.audioGuardId = identifier;
    await this.evaluate(tab, `window.__eosSetForceMuted && window.__eosSetForceMuted(${effective})`);
  }

  private async isAudible(tab: Tab): Promise<boolean> {
    try {
      return (await this.evaluate<boolean>(tab, "!!(window.__eosIsAudible && window.__eosIsAudible())")) === true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    const child = this.child;
    this.child = null;
    this.cdp = null;
    this.tabs.clear();
    this.keepAliveSessionId = null;
    this.foregroundTabId = null;
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }

  // ---- internals -------------------------------------------------------------

  private setLoading(sessionId: string | undefined, loading: boolean): void {
    for (const tab of this.tabs.values()) {
      if (tab.sessionId === sessionId) tab.loading = loading;
    }
  }

  // Always sends — cheap and idempotent; the tracked id only drives capture's
  // flip/restore decision, so drift in Chrome can never suppress the call.
  private async bringToFront(tab: Tab): Promise<void> {
    await this.mustCdp().send("Page.bringToFront", {}, tab.sessionId);
    this.foregroundTabId = tab.tabId;
  }

  private resolveRef(tab: Tab, ref: string): number {
    const backendNodeId = tab.refs.get(ref);
    if (backendNodeId == null) {
      throw new StaleRefError(
        `unknown or stale ref ${JSON.stringify(ref)} — the page has changed since it was minted; call snapshot (or find) again for fresh refs`,
      );
    }
    return backendNodeId;
  }

  private async backendNodeForSelector(tab: Tab, selector: string): Promise<number> {
    const cdp = this.mustCdp();
    const doc = (await cdp.send("DOM.getDocument", { depth: 0 }, tab.sessionId)) as { root: { nodeId: number } };
    const found = (await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector }, tab.sessionId)) as { nodeId: number };
    if (!found.nodeId) throw new Error(`selector matched nothing: ${selector}`);
    const desc = (await cdp.send("DOM.describeNode", { nodeId: found.nodeId }, tab.sessionId)) as { node: { backendNodeId: number } };
    return desc.node.backendNodeId;
  }

  private async boxOf(tab: Tab, backendNodeId: number): Promise<[number, number, number, number]> {
    const { model } = (await this.mustCdp().send("DOM.getBoxModel", { backendNodeId }, tab.sessionId)) as {
      model: { border: number[] };
    };
    const q = model.border;
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return [Math.round(x), Math.round(y), Math.round(Math.max(...xs) - x), Math.round(Math.max(...ys) - y)];
  }

  private async centerOf(tab: Tab, backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.mustCdp().send("DOM.scrollIntoViewIfNeeded", { backendNodeId }, tab.sessionId).catch(() => {});
    const [x, y, w, h] = await this.boxOf(tab, backendNodeId);
    return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
  }

  // Trusted click: real Input.dispatchMouseEvent at the node's centre — pages
  // see isTrusted:true, unlike element.click().
  private async trustedClick(tab: Tab, backendNodeId: number): Promise<void> {
    const { x, y } = await this.centerOf(tab, backendNodeId);
    const base = { x, y, button: "left" as const, clickCount: 1 };
    await this.mouse(tab, { ...base, type: "mouseMoved", button: "none", clickCount: 0 });
    await this.mouse(tab, { ...base, type: "mousePressed", buttons: 1 });
    await this.mouse(tab, { ...base, type: "mouseReleased", buttons: 0 });
  }

  private async evaluate<T = unknown>(tab: Tab, expression: string): Promise<T | undefined> {
    const r = (await this.mustCdp().send("Runtime.evaluate", { expression, returnByValue: true }, tab.sessionId)) as {
      result: { value?: T };
      exceptionDetails?: { text?: string };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate failed");
    return r.result.value;
  }

  private async callOnNode<T = unknown>(tab: Tab, backendNodeId: number, functionDeclaration: string): Promise<T | undefined> {
    const cdp = this.mustCdp();
    const resolved = (await cdp.send("DOM.resolveNode", { backendNodeId }, tab.sessionId)) as { object: { objectId: string } };
    const r = (await cdp.send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration,
      returnByValue: true,
    }, tab.sessionId)) as { result: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "node call failed");
    return r.result.value;
  }

  private mustCdp(): CdpPipeClient {
    if (!this.cdp || this.cdp.isClosed()) throw new Error("browser is not running");
    return this.cdp;
  }

  private mustTab(tabId: string): Tab {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`unknown tab: ${tabId}`);
    return tab;
  }
}
