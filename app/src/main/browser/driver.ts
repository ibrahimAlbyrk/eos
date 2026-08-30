import { randomBytes } from "node:crypto";
import { formatAXTree, roleOf, statesOf, type AXNodeLike } from "../../../../infra/src/browser/snapshotFormatter";
import { parseChord } from "../../../../infra/src/browser/keys";
import type { ViewManager, TabHandle } from "./views";

// MainWebContentsDriver — the app-side automation, the same CDP verb sequencing
// the headless CdpBrowserAdapter runs, re-hosted on each view's
// webContents.debugger (one debugger per tab, no sessionId multiplexing). The
// pure ref/format code (formatAXTree, @eN minting, parseChord) is IMPORTED from
// infra, not duplicated. @eN refs are minted per tab and invalidated on
// main-frame navigation (ViewManager wires the clear) — a stale ref raises
// StaleRefError, whose name survives the control channel so the daemon route
// still maps it to a 409.

// The daemon rehydrates by name — must read "StaleRefError" across the hop.
class StaleRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleRefError";
  }
}

// Mirrors contracts BrowserElement (built as plain JSON — importing the zod
// contract into the app would drag zod + .ts-extension specifiers the app tsc
// rejects; the wire shape is JSON either way).
interface Element {
  ref: string;
  tag: string;
  role: string;
  name: string;
  box: [number, number, number, number];
  focusable: boolean;
  state?: string[];
  value?: string;
  locator: string;
}

type NavigateAction = "url" | "back" | "forward" | "reload";
type ActVerb = "click" | "hover" | "focus" | "check" | "uncheck";
type ScrollDirection = "up" | "down" | "top" | "bottom";
type GetWhat = "text" | "url" | "title" | "value";
type Device = "responsive" | "mobile" | "tablet";

const TEXT_CAP = 40_000;
const FIND_MATCH_CAP = 10;
// Full-page capture caps (a clip taller than ~8192 device px wedges Chromium).
const MAX_CAPTURE_PX = 2048;
const MAX_FULLPAGE_PX = 8192;

const DEVICE_PROFILES = {
  responsive: { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false, touch: false, userAgent: null as string | null, platform: null as string | null },
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

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

export class MainWebContentsDriver {
  private views: ViewManager;
  // Per-tab serialization (R3): concurrent agent verbs on one webContents chain
  // instead of interleaving (an agent click landing mid-way through another).
  private locks = new Map<string, Promise<unknown>>();

  constructor(views: ViewManager) {
    this.views = views;
  }

  // The frame dispatcher — the channel hands (method, sessionKey, args) straight
  // through. Session-scoped verbs (no tabId) run directly; tab-scoped verbs
  // serialize per tab and re-attach the debugger first (R6) so DevTools opening
  // on a tab can't wedge or crash the agent.
  async handle(method: string, sessionKey: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "launch": return this.launch(sessionKey);
      case "openTab": return this.openTab(sessionKey, str(args[0]));
      case "listTabs": return this.listTabs(sessionKey);
      case "dispose": this.views.disposeSession(sessionKey); return null;
    }
    const tabId = str(args[0]);
    return this.withTabLock(tabId, () => this.tabVerb(method, tabId, args));
  }

  private async tabVerb(method: string, tabId: string, args: unknown[]): Promise<unknown> {
    if (method === "closeTab") {
      this.views.removeTab(tabId);
      this.locks.delete(tabId);
      return null;
    }
    const t = this.views.mustTab(tabId);
    await this.ensureAttached(t);
    switch (method) {
      case "navigate": return this.navigate(tabId, args[1] as NavigateAction, args[2] == null ? undefined : str(args[2]));
      case "snapshot": return this.snapshot(tabId, args[1] as { interactiveOnly: boolean; selector?: string; depth?: number });
      case "find": return this.find(tabId, str(args[1]));
      case "act": return this.act(tabId, str(args[1]), args[2] as ActVerb);
      case "typeText": return this.typeText(tabId, str(args[1]), str(args[2]), Boolean(args[3]));
      case "press": return this.press(tabId, str(args[1]));
      case "scroll": return this.scroll(tabId, args[1] as ScrollDirection, args[2] == null ? undefined : str(args[2]));
      case "get": return this.get(tabId, args[1] as GetWhat, args[2] == null ? undefined : str(args[2]));
      case "capture": return this.capture(tabId, Boolean(args[1]));
      case "setDevice": return this.setDevice(tabId, args[1] as Device);
      case "elementAt": return this.elementAt(tabId, Number(args[1]), Number(args[2]));
      case "textPresent": return this.textPresent(tabId, str(args[1]));
      case "refVisible": return this.refVisible(tabId, str(args[1]));
      case "setMuted": return this.setMuted(tabId, Boolean(args[1]));
      default: throw new Error(`unknown browser method: ${method}`);
    }
  }

  // Chain verbs on one tab so they never interleave. The stored tail never
  // rejects, so one failed verb doesn't poison the next.
  private withTabLock<T>(tabId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(tabId) ?? Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    this.locks.set(tabId, run.then(() => undefined, () => undefined));
    return run as Promise<T>;
  }

  // Keep the agent's debugger attached for the view's life; if DevTools grabbed
  // the target (single CDP client per target), re-attach + re-enable domains.
  // While DevTools still holds it, attach throws and the verb fails clearly
  // instead of hanging — and the next verb recovers once DevTools closes (R6).
  private async ensureAttached(t: TabHandle): Promise<void> {
    if (t.dbg.isAttached()) return;
    try {
      t.dbg.attach("1.3");
    } catch (e) {
      throw new Error(`browser debugger unavailable (DevTools may be open on this tab): ${e instanceof Error ? e.message : String(e)}`);
    }
    await t.dbg.sendCommand("Page.enable").catch(() => {});
    await t.dbg.sendCommand("DOM.enable").catch(() => {});
    await t.dbg.sendCommand("Accessibility.enable").catch(() => {});
    await t.dbg.sendCommand("Runtime.enable").catch(() => {});
  }

  private async launch(_sessionKey: string): Promise<null> {
    // The host window is already up — nothing to spawn. The partition + views are
    // created lazily on openTab.
    return null;
  }

  private async openTab(sessionKey: string, url: string): Promise<string> {
    const tabId = `bt-${randomBytes(6).toString("hex")}`;
    const t = this.views.createTab(tabId, sessionKey);
    if (url && url !== "about:blank") await t.dbg.sendCommand("Page.navigate", { url });
    return tabId;
  }

  private async listTabs(sessionKey: string): Promise<Array<Record<string, unknown>>> {
    return this.views.tabsForSession(sessionKey).map((t) => {
      const wc = t.view.webContents;
      return {
        tabId: t.tabId,
        url: safe(() => wc.getURL(), ""),
        title: safe(() => wc.getTitle(), ""),
        loading: safe(() => wc.isLoading(), false),
        canGoBack: safe(() => wc.navigationHistory.canGoBack(), false),
        canGoForward: safe(() => wc.navigationHistory.canGoForward(), false),
        audible: safe(() => wc.isCurrentlyAudible(), false),
        muted: safe(() => wc.isAudioMuted(), false),
        faviconDataUri: null,
      };
    });
  }

  private async navigate(tabId: string, action: NavigateAction, url?: string): Promise<null> {
    const t = this.views.mustTab(tabId);
    if (action === "url") {
      if (!url) throw new Error("navigate action 'url' requires a url");
      await t.dbg.sendCommand("Page.navigate", { url });
      return null;
    }
    if (action === "reload") {
      await t.dbg.sendCommand("Page.reload");
      return null;
    }
    const hist = (await t.dbg.sendCommand("Page.getNavigationHistory")) as { currentIndex: number; entries: Array<{ id: number }> };
    const target = hist.entries[hist.currentIndex + (action === "back" ? -1 : 1)];
    if (!target) return null;
    await t.dbg.sendCommand("Page.navigateToHistoryEntry", { entryId: target.id });
    return null;
  }

  // ---- snapshot / find ------------------------------------------------------

  private async snapshot(tabId: string, opts: { interactiveOnly: boolean; selector?: string; depth?: number }): Promise<{ url: string; snapshot: string }> {
    const t = this.views.mustTab(tabId);
    let rootBackendNodeId: number | undefined;
    if (opts.selector) rootBackendNodeId = await this.backendNodeForSelector(t, opts.selector);
    const { nodes } = (await t.dbg.sendCommand("Accessibility.getFullAXTree")) as { nodes: AXNodeLike[] };
    t.refs.clear();
    const result = formatAXTree(nodes, {
      interactiveOnly: opts.interactiveOnly,
      depth: opts.depth,
      rootBackendNodeId,
      refStart: t.refCounter,
    });
    t.refCounter = result.nextRefIndex;
    for (const [ref, backendNodeId] of result.refs) t.refs.set(ref, backendNodeId);
    return { url: safe(() => t.view.webContents.getURL(), ""), snapshot: result.text };
  }

  private async find(tabId: string, query: string): Promise<Element[]> {
    const t = this.views.mustTab(tabId);
    const reMatch = query.match(/^\/(.+)\/([a-z]*)$/);
    const test = reMatch
      ? (s: string) => new RegExp(reMatch[1], reMatch[2].includes("i") ? reMatch[2] : reMatch[2] + "i").test(s)
      : (s: string) => s.toLowerCase().includes(query.toLowerCase());
    const { nodes } = (await t.dbg.sendCommand("Accessibility.getFullAXTree")) as { nodes: AXNodeLike[] };
    const out: Element[] = [];
    for (const node of nodes) {
      if (out.length >= FIND_MATCH_CAP) break;
      if (node.ignored || node.backendDOMNodeId == null) continue;
      const role = roleOf(node);
      if (role === "statictext" || role === "inlinetextbox" || role === "rootwebarea") continue;
      const name = String(node.name?.value ?? "");
      if (!name || !test(name)) continue;
      const el = await this.buildElement(t, node.backendDOMNodeId, node).catch(() => null);
      if (el) out.push(el);
    }
    return out;
  }

  // ---- act verbs ------------------------------------------------------------

  private async act(tabId: string, ref: string, verb: ActVerb): Promise<null> {
    const t = this.views.mustTab(tabId);
    const backendNodeId = this.resolveRef(t, ref);
    if (verb === "focus") {
      await t.dbg.sendCommand("DOM.focus", { backendNodeId });
      return null;
    }
    if (verb === "check" || verb === "uncheck") {
      const checked = await this.callOnNode<boolean>(t, backendNodeId, "function(){ return !!this.checked }");
      if (checked === (verb === "check")) return null;
      await this.trustedClick(t, backendNodeId);
      return null;
    }
    if (verb === "hover") {
      const { x, y } = await this.centerOf(t, backendNodeId);
      await this.mouse(t, { type: "mouseMoved", x, y, button: "none" });
      return null;
    }
    await this.trustedClick(t, backendNodeId);
    return null;
  }

  private async typeText(tabId: string, ref: string, text: string, submit: boolean): Promise<null> {
    const t = this.views.mustTab(tabId);
    const backendNodeId = this.resolveRef(t, ref);
    await t.dbg.sendCommand("DOM.focus", { backendNodeId });
    await this.callOnNode(t, backendNodeId, `function(){
      if (this.select) this.select();
      else if (this.isContentEditable) {
        const r = document.createRange(); r.selectNodeContents(this);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      }
    }`);
    await t.dbg.sendCommand("Input.insertText", { text });
    if (submit) await this.press(tabId, "Enter");
    return null;
  }

  private async press(tabId: string, key: string): Promise<null> {
    const t = this.views.mustTab(tabId);
    const chord = parseChord(key);
    const base = {
      key: chord.key,
      code: chord.code,
      modifiers: chord.modifiers,
      windowsVirtualKeyCode: chord.windowsVirtualKeyCode,
      nativeVirtualKeyCode: chord.windowsVirtualKeyCode,
    };
    await t.dbg.sendCommand("Input.dispatchKeyEvent", { ...base, type: chord.text ? "keyDown" : "rawKeyDown", text: chord.text, unmodifiedText: chord.text });
    await t.dbg.sendCommand("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
    return null;
  }

  private async scroll(tabId: string, direction: ScrollDirection, ref?: string): Promise<null> {
    const t = this.views.mustTab(tabId);
    if (ref) {
      const backendNodeId = this.resolveRef(t, ref);
      await this.callOnNode(t, backendNodeId, `function(){
        const d = ${JSON.stringify(direction)};
        if (d === "top") this.scrollTo(0, 0);
        else if (d === "bottom") this.scrollTo(0, this.scrollHeight);
        else this.scrollBy(0, (d === "up" ? -0.8 : 0.8) * this.clientHeight);
      }`);
      return null;
    }
    if (direction === "top" || direction === "bottom") {
      await this.evaluate(t, direction === "top" ? "window.scrollTo(0, 0)" : "window.scrollTo(0, document.body.scrollHeight)");
      return null;
    }
    // JS scroll, not a trusted mouseWheel: CDP Input.dispatchMouseEvent{mouseWheel}
    // hangs on an embedded WebContentsView (the ack never returns), so a wheel
    // scroll would wedge the RPC. scrollBy covers the common case reliably.
    await this.evaluate(t, `window.scrollBy(0, (${direction === "up" ? -0.8 : 0.8}) * window.innerHeight)`);
    return null;
  }

  // ---- reads ----------------------------------------------------------------

  private async get(tabId: string, what: GetWhat, ref?: string): Promise<string> {
    const t = this.views.mustTab(tabId);
    if (what === "url") return safe(() => t.view.webContents.getURL(), "");
    if (what === "title") return safe(() => t.view.webContents.getTitle(), "");
    if (what === "text") {
      if (!ref) return (await this.evaluate<string>(t, `document.body ? document.body.innerText.slice(0, ${TEXT_CAP}) : ""`)) ?? "";
      const backendNodeId = this.resolveRef(t, ref);
      return (await this.callOnNode<string>(t, backendNodeId, `function(){ return String(this.innerText ?? this.textContent ?? "").slice(0, ${TEXT_CAP}) }`)) ?? "";
    }
    if (!ref) throw new Error("get 'value' requires a ref");
    const backendNodeId = this.resolveRef(t, ref);
    return (await this.callOnNode<string>(t, backendNodeId, `function(){
      if (this.type === "password") return "[redacted]";
      return String(this.value ?? "");
    }`)) ?? "";
  }

  // Base64 JPEG (the control channel is text-only; the daemon rehydrates to bytes
  // and writes the temp file exactly as for the headless lane). capturePage()
  // composites the on-screen view and is best when a human panel is sizing it;
  // but an agent-driven tab that no panel is showing has no on-screen surface, so
  // capturePage returns empty. Fall back to CDP Page.captureScreenshot, imposing a
  // default viewport when the view is unsized (the headless approach), then
  // clearing it so a later human view keeps its native sizing.
  private async capture(tabId: string, fullPage: boolean): Promise<string> {
    const t = this.views.mustTab(tabId);
    if (fullPage) {
      const full = await this.captureFullPage(t).catch(() => null);
      if (full != null) return full;
      // captureBeyondViewport wedges on an embedded WebContentsView (I-3), and
      // the tall-viewport path above can time out — degrade to a viewport shot
      // rather than hang the RPC or return empty.
    }
    const img = await t.view.webContents.capturePage();
    if (!img.isEmpty()) return img.toJPEG(80).toString("base64");
    const imposed = await this.ensureCaptureViewport(t);
    try {
      const shot = (await t.dbg.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 80 })) as { data: string };
      return shot.data;
    } finally {
      if (imposed) await t.dbg.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }
  }

  // Full page via captureBeyondViewport with an explicit clip sized to the content
  // (getLayoutMetrics). No Emulation.setDeviceMetricsOverride — that segfaults V8's
  // inspector on this WebContentsView. Timeout-guarded so a wedge (a known embedded
  // failure mode, I-3) rejects and the caller degrades to a viewport shot.
  private async captureFullPage(t: TabHandle): Promise<string> {
    const metrics = (await this.withTimeout(t.dbg.sendCommand("Page.getLayoutMetrics"), 4000)) as {
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const content = metrics.cssContentSize ?? metrics.contentSize;
    if (!content) throw new Error("no layout metrics");
    const width = Math.max(1, Math.min(Math.round(content.width), MAX_CAPTURE_PX));
    const height = Math.max(1, Math.min(Math.round(content.height), MAX_FULLPAGE_PX));
    const shot = (await this.withTimeout(t.dbg.sendCommand("Page.captureScreenshot", {
      format: "jpeg", quality: 80, captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    }), 6000)) as { data: string };
    return shot.data;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("cdp timeout")), ms);
        timer.unref?.();
      }),
    ]);
  }

  // Give an unsized view (zero layout viewport, e.g. no panel showing it) a
  // default viewport so the screenshot has real pixels. Returns whether an
  // override was applied so the caller clears it afterward. A sized/emulated view
  // (innerWidth > 1) is left untouched — no flash for the human-visible case.
  private async ensureCaptureViewport(t: TabHandle): Promise<boolean> {
    const [w, h] = await this.viewportSize(t);
    if (w > 1 && h > 1) return false;
    await t.dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    return true;
  }

  // ---- device emulation -----------------------------------------------------

  private async setDevice(tabId: string, device: Device): Promise<null> {
    const t = this.views.mustTab(tabId);
    const p = DEVICE_PROFILES[device];
    // Record the device on the view manager too: it resizes+centers the visible
    // view to the device rect (FIX 3) — the CDP metrics below emulate the page,
    // the view bounds place it centered in the panel.
    this.views.setDevice(tabId, device);
    if (device === "responsive") {
      await t.dbg.sendCommand("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await t.dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    } else {
      await t.dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width: p.width, height: p.height, deviceScaleFactor: p.deviceScaleFactor, mobile: p.mobile });
      await t.dbg.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: p.touch, maxTouchPoints: 5 }).catch(() => {});
      await t.dbg.sendCommand("Emulation.setEmitTouchEventsForMouse", { enabled: p.touch, configuration: "mobile" }).catch(() => {});
      if (p.userAgent) await t.dbg.sendCommand("Emulation.setUserAgentOverride", { userAgent: p.userAgent, ...(p.platform ? { platform: p.platform } : {}) });
    }
    await t.dbg.sendCommand("Page.reload");
    return null;
  }

  // ---- element picker -------------------------------------------------------

  private async elementAt(tabId: string, x: number, y: number): Promise<Element> {
    const t = this.views.mustTab(tabId);
    const hit = (await t.dbg.sendCommand("DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false })) as { backendNodeId: number };
    return this.elementForBackendNode(t, hit.backendNodeId);
  }

  // Resolve a backendNodeId to a full BrowserElement (accname/role via a partial
  // AX tree, mints a fresh @eN). Shared by the coordinate picker (elementAt) and
  // the native inspect-mode picker (pickElement).
  private async elementForBackendNode(t: TabHandle, backendNodeId: number): Promise<Element> {
    const ax = (await t.dbg.sendCommand("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false })) as { nodes: AXNodeLike[] };
    const node: AXNodeLike = ax.nodes[0] ?? { nodeId: "0", backendDOMNodeId: backendNodeId };
    return this.buildElement(t, backendNodeId, node);
  }

  // ---- native element pick (human, over the LIVE view) ----------------------
  // The human's mouse is over the native WebContentsView, not the React DOM, so
  // the renderer can't capture hover/click coords. Instead drive Chromium's own
  // inspect overlay via CDP: Overlay.setInspectMode highlights elements ON the
  // live page as the human hovers (native highlight, no DOM), and a click fires
  // Overlay.inspectNodeRequested with the chosen node — the click is consumed by
  // the overlay, never delivered to the page. The picked ref is minted in the
  // same per-tab refs map the agent resolves against, so an agent can act on it.
  private pick: { tabId: string; resolve: (el: Element | null) => void; cleanup: () => void } | null = null;

  async pickElement(tabId: string): Promise<Element | null> {
    const t = this.views.mustTab(tabId);
    await this.ensureAttached(t);
    this.cancelPick(); // only one pick at a time
    await t.dbg.sendCommand("Overlay.enable").catch(() => {});
    return new Promise<Element | null>((resolve) => {
      const onMessage = (_e: unknown, method: string, params: unknown): void => {
        if (method !== "Overlay.inspectNodeRequested") return;
        const backendNodeId = (params as { backendNodeId?: number })?.backendNodeId;
        cleanup();
        if (backendNodeId == null) { resolve(null); return; }
        this.elementForBackendNode(t, backendNodeId).then(resolve).catch(() => resolve(null));
      };
      let done = false;
      const cleanup = (): void => {
        if (done) return;
        done = true;
        try { t.dbg.removeListener("message", onMessage); } catch { /* already gone */ }
        if (this.pick?.resolve === resolve) this.pick = null;
        void t.dbg.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} }).catch(() => {});
        void t.dbg.sendCommand("Overlay.hideHighlight").catch(() => {});
      };
      this.pick = { tabId, resolve, cleanup };
      t.dbg.on("message", onMessage);
      void t.dbg.sendCommand("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig: {
          showInfo: true,
          contentColor: { r: 111, g: 168, b: 220, a: 0.42 },
          paddingColor: { r: 147, g: 196, b: 125, a: 0.35 },
          borderColor: { r: 255, g: 229, b: 153, a: 0.45 },
          marginColor: { r: 246, g: 178, b: 107, a: 0.32 },
        },
      }).catch(() => { cleanup(); resolve(null); });
    });
  }

  // Abort an in-flight pick (the human left pick mode) — resolves its promise null.
  cancelPick(): void {
    const p = this.pick;
    if (!p) return;
    this.pick = null;
    p.cleanup();
    p.resolve(null);
  }

  // ---- wait probes ----------------------------------------------------------

  private async textPresent(tabId: string, text: string): Promise<boolean> {
    const t = this.views.mustTab(tabId);
    const hit = await this.evaluate<boolean>(t, `!!document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`);
    return hit === true;
  }

  private async refVisible(tabId: string, ref: string): Promise<boolean> {
    const t = this.views.mustTab(tabId);
    const backendNodeId = this.resolveRef(t, ref);
    try {
      await this.boxOf(t, backendNodeId);
      return true;
    } catch {
      return false;
    }
  }

  // ---- audio ----------------------------------------------------------------

  private async setMuted(tabId: string, muted: boolean): Promise<null> {
    const t = this.views.mustTab(tabId);
    safe(() => t.view.webContents.setAudioMuted(muted), undefined);
    return null;
  }

  // ---- internals ------------------------------------------------------------

  private resolveRef(t: TabHandle, ref: string): number {
    const backendNodeId = t.refs.get(ref);
    if (backendNodeId == null) {
      throw new StaleRefError(
        `unknown or stale ref ${JSON.stringify(ref)} — the page has changed since it was minted; call snapshot (or find) again for fresh refs`,
      );
    }
    return backendNodeId;
  }

  private async backendNodeForSelector(t: TabHandle, selector: string): Promise<number> {
    const doc = (await t.dbg.sendCommand("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
    const found = (await t.dbg.sendCommand("DOM.querySelector", { nodeId: doc.root.nodeId, selector })) as { nodeId: number };
    if (!found.nodeId) throw new Error(`selector matched nothing: ${selector}`);
    const desc = (await t.dbg.sendCommand("DOM.describeNode", { nodeId: found.nodeId })) as { node: { backendNodeId: number } };
    return desc.node.backendNodeId;
  }

  private async buildElement(t: TabHandle, backendNodeId: number, ax: AXNodeLike): Promise<Element> {
    const desc = (await t.dbg.sendCommand("DOM.describeNode", { backendNodeId })) as { node: { nodeName: string; attributes?: string[] } };
    const tag = desc.node.nodeName.toLowerCase();
    const box = await this.boxOf(t, backendNodeId);
    const role = roleOf(ax) || tag;
    const name = String(ax.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    const states = statesOf(ax);
    const attrs = new Map<string, string>();
    const list = desc.node.attributes ?? [];
    for (let i = 0; i + 1 < list.length; i += 2) attrs.set(list[i], list[i + 1]);
    t.refCounter += 1;
    const ref = `@e${t.refCounter}`;
    t.refs.set(ref, backendNodeId);
    let value: string | undefined;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      value = attrs.get("type") === "password"
        ? undefined
        : (await this.callOnNode<string>(t, backendNodeId, "function(){ return String(this.value ?? \"\") }").catch(() => "")) || undefined;
    }
    const locator = name
      ? `role=${role}[name=${JSON.stringify(name)}]`
      : attrs.get("id") ? `#${attrs.get("id")}` : tag;
    return {
      ref, tag, role, name, box,
      focusable: (ax.properties ?? []).some((p) => p.name.toLowerCase() === "focusable" && p.value?.value === true),
      ...(states.length ? { state: states } : {}),
      ...(value !== undefined ? { value: value.slice(0, 100) } : {}),
      locator,
    };
  }

  private async boxOf(t: TabHandle, backendNodeId: number): Promise<[number, number, number, number]> {
    const { model } = (await t.dbg.sendCommand("DOM.getBoxModel", { backendNodeId })) as { model: { border: number[] } };
    const q = model.border;
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return [Math.round(x), Math.round(y), Math.round(Math.max(...xs) - x), Math.round(Math.max(...ys) - y)];
  }

  private async centerOf(t: TabHandle, backendNodeId: number): Promise<{ x: number; y: number }> {
    await t.dbg.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    const [x, y, w, h] = await this.boxOf(t, backendNodeId);
    return { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
  }

  private async trustedClick(t: TabHandle, backendNodeId: number): Promise<void> {
    const { x, y } = await this.centerOf(t, backendNodeId);
    const base = { x, y, button: "left" as const, clickCount: 1 };
    await this.mouse(t, { ...base, type: "mouseMoved", button: "none", clickCount: 0 });
    await this.mouse(t, { ...base, type: "mousePressed", buttons: 1 });
    await this.mouse(t, { ...base, type: "mouseReleased", buttons: 0 });
  }

  private async mouse(t: TabHandle, p: { type: string; x: number; y: number; button?: string; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number }): Promise<void> {
    await t.dbg.sendCommand("Input.dispatchMouseEvent", {
      type: p.type,
      x: p.x,
      y: p.y,
      button: p.button ?? "none",
      buttons: p.buttons ?? 0,
      clickCount: p.clickCount ?? 0,
      deltaX: p.deltaX ?? 0,
      deltaY: p.deltaY ?? 0,
    });
  }

  private async viewportSize(t: TabHandle): Promise<[number, number]> {
    const r = await this.evaluate<{ w: number; h: number }>(t, "({w: window.innerWidth, h: window.innerHeight})");
    return [Math.max(1, r?.w ?? 1280), Math.max(1, r?.h ?? 800)];
  }

  private async evaluate<T = unknown>(t: TabHandle, expression: string): Promise<T | undefined> {
    const r = (await t.dbg.sendCommand("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate failed");
    return r.result.value;
  }

  private async callOnNode<T = unknown>(t: TabHandle, backendNodeId: number, functionDeclaration: string): Promise<T | undefined> {
    const resolved = (await t.dbg.sendCommand("DOM.resolveNode", { backendNodeId })) as { object: { objectId: string } };
    const r = (await t.dbg.sendCommand("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration,
      returnByValue: true,
    })) as { result: { value?: T }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "node call failed");
    return r.result.value;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}
