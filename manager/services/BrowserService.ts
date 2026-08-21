// BrowserService — daemon-side owner of the ONE shared Chrome (engine
// supervision + tab registry + frame fan-out + nav policy). Humans reach it
// through routes/browser.ts + the /browser/stream WS; agents reach the
// identical session through the browser_* tools (Phase 3). Chrome plays audio
// straight to the system output device — only pictures travel over CDP.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type {
  BrowserEngine,
  BrowserFrame,
  BrowserInputEvent,
  DisplaySize,
} from "../../core/src/ports/BrowserEngine.ts";
import type {
  BrowserActRequest,
  BrowserDevice,
  BrowserElement,
  BrowserElementQuery,
  BrowserFillFormRequest,
  BrowserFindResponse,
  BrowserGetRequest,
  BrowserGetResponse,
  BrowserNavigateRequest,
  BrowserPressRequest,
  BrowserScrollRequest,
  BrowserSnapshotRequest,
  BrowserSnapshotResponse,
  BrowserStatus,
  BrowserTab,
  BrowserTypeRequest,
  BrowserWaitRequest,
  BrowserWaitResponse,
} from "../../contracts/src/browser.ts";

export interface BrowserConfigSlice {
  enabled: boolean;
  chromePath: string | null;
  allowedOrigins: string[];
  persistProfile: boolean;
}

// Who is driving. Derived SERVER-SIDE in routes/browser.ts from the per-boot
// ui token alone (token ⇒ the human panel; a browser_* tool handler's bare
// loopback ctx.api() carries no token ⇒ agent) — never read from a request
// body, so an agent cannot claim to be the human. Defaults below are "agent"
// (fail closed): a caller that forgets to declare gets the fenced experience.
export type BrowserActor = "human" | "agent";

interface Log {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

// config.browser.enabled === false — every route maps this to a 409.
export class BrowserDisabledError extends Error {
  constructor() {
    super("browser subsystem is disabled");
  }
}

// Navigation refused by the allowedOrigins allowlist — routes map this to a
// 403 with a message clear enough for the panel to show a blocked state.
export class BrowserNavBlockedError extends Error {}

// A new tab opens BLANK and stays there — navigation happens only when the
// human types a URL (the reference product's empty-state new tab, rendered by
// BrowserEmptyState). There is no hardcoded start site. The adapter's
// about:blank bootstrap + resetNavigationHistory is unchanged; only the default
// destination is gone.
export const NEW_TAB_URL = "about:blank";

// Fallback display when the panel subscribes/resumes without reporting its size
// (e.g. a control message that predates the size fields). The panel normally
// sends its live CSS size, so this only guards the seam.
export const DISPLAY_DEFAULTS: DisplaySize = { cssWidth: 1280, cssHeight: 800, dpr: 2 };

// Request/response headers that must never reach a tool result. Exact
// credential carriers plus the token/api-key naming family.
const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|session|auth/i;

const WAIT_POLL_MS = 250;

export class BrowserService {
  private engine: BrowserEngine;
  private getConfig: () => BrowserConfigSlice;
  private bus: EventBus;
  private log: Log;
  private launching: Promise<void> | null = null;
  private crashed = false;
  private subscribers = new Map<string, Set<(frame: BrowserFrame) => void>>();
  private tabCount = 0;

  constructor(deps: { engine: BrowserEngine; getConfig: () => BrowserConfigSlice; bus: EventBus; log: Log }) {
    this.engine = deps.engine;
    this.getConfig = deps.getConfig;
    this.bus = deps.bus;
    this.log = deps.log;
    this.engine.onExit(({ code }) => {
      this.crashed = true;
      this.subscribers.clear();
      this.log.warn("browser engine exited", { code });
      this.publishStatus();
    });
  }

  status(): BrowserStatus {
    return {
      state: this.stateOf(),
      chromePath: this.engine.binaryPath(),
      // Updated by publishTabs; 0 while the engine is down.
      tabCount: this.engine.isRunning() ? this.tabCount : 0,
    };
  }

  async ensureLaunched(): Promise<void> {
    this.assertEnabled();
    if (this.engine.isRunning()) return;
    if (!this.launching) {
      this.publishStatus();
      this.launching = this.engine
        .launch()
        .then(() => {
          this.crashed = false;
        })
        .finally(() => {
          this.launching = null;
          this.publishStatus();
        });
    }
    await this.launching;
  }

  async openTab(url = NEW_TAB_URL, actor: BrowserActor = "agent"): Promise<string> {
    this.assertEnabled();
    await this.ensureLaunched();
    this.enforceNavPolicy(url, actor);
    const tabId = await this.engine.openTab(url);
    await this.publishTabs();
    return tabId;
  }

  async closeTab(tabId: string): Promise<void> {
    this.assertEnabled();
    this.subscribers.delete(tabId);
    await this.engine.closeTab(tabId);
    await this.publishTabs();
  }

  async listTabs(): Promise<BrowserTab[]> {
    this.assertEnabled();
    if (!this.engine.isRunning()) return [];
    // audible comes live from the injected audio guard; muted is user-level.
    return this.engine.listTabs();
  }

  // The foreground tab — the one the panel is viewing (set when the panel
  // subscribes to a tab's frames → startScreencast → bringToFront). An omitted
  // tabId resolves here so an agent's "this page" is the page the human sees;
  // null when no real tab is foreground, which the route maps to a clear "no
  // active tab" rather than silently picking one.
  activeTabId(): string | null {
    this.assertEnabled();
    return this.engine.activeTabId();
  }

  async navigate(tabId: string, req: BrowserNavigateRequest, actor: BrowserActor = "agent"): Promise<void> {
    this.assertEnabled();
    if (req.action === "url") {
      if (!req.url) throw new Error("navigate action 'url' requires a url");
      this.enforceNavPolicy(req.url, actor);
    }
    await this.engine.navigate(tabId, req.action, req.url);
    await this.publishTabs();
  }

  // ---- agent verbs -----------------------------------------------------------

  async snapshot(tabId: string, req: BrowserSnapshotRequest): Promise<BrowserSnapshotResponse> {
    this.assertEnabled();
    const r = await this.engine.snapshot(tabId, {
      interactiveOnly: req.interactiveOnly,
      selector: req.selector,
      depth: req.depth,
    });
    return { tabId, url: r.url, snapshot: r.snapshot };
  }

  async find(tabId: string, query: string): Promise<BrowserFindResponse> {
    this.assertEnabled();
    const matches = await this.engine.find(tabId, query);
    return { tabId, url: await this.engine.get(tabId, "url"), matches };
  }

  async act(tabId: string, req: BrowserActRequest): Promise<{ ok: true; snapshot?: BrowserSnapshotResponse }> {
    this.assertEnabled();
    await this.engine.act(tabId, req.ref, req.verb);
    return this.withOptionalSnapshot(tabId, req.includeSnapshot);
  }

  async typeText(tabId: string, req: BrowserTypeRequest): Promise<{ ok: true; snapshot?: BrowserSnapshotResponse }> {
    this.assertEnabled();
    await this.engine.typeText(tabId, req.ref, req.text, req.submit);
    return this.withOptionalSnapshot(tabId, req.includeSnapshot);
  }

  async fillForm(tabId: string, req: BrowserFillFormRequest): Promise<{ ok: true }> {
    this.assertEnabled();
    for (const field of req.fields) {
      await this.engine.typeText(tabId, field.ref, field.value, false);
    }
    return { ok: true };
  }

  async press(tabId: string, req: BrowserPressRequest): Promise<{ ok: true }> {
    this.assertEnabled();
    await this.engine.press(tabId, req.key);
    return { ok: true };
  }

  async scroll(tabId: string, req: BrowserScrollRequest): Promise<{ ok: true }> {
    this.assertEnabled();
    await this.engine.scroll(tabId, req.direction, req.ref);
    return { ok: true };
  }

  async get(tabId: string, req: BrowserGetRequest): Promise<BrowserGetResponse> {
    this.assertEnabled();
    return { tabId, what: req.what, value: await this.engine.get(tabId, req.what, req.ref) };
  }

  // JPEG bytes → temp file (same convention as POST /fs/paste): the MCP
  // channel is text-only, so bytes never travel as a return value.
  async capture(tabId: string, fullPage: boolean): Promise<{ path: string }> {
    this.assertEnabled();
    const bytes = await this.engine.capture(tabId, fullPage);
    const dir = mkdtempSync(join(tmpdir(), "eos-paste-"));
    const path = join(dir, `browser-${tabId}-${Date.now()}.jpeg`);
    writeFileSync(path, bytes);
    return { path };
  }

  async setDevice(tabId: string, device: BrowserDevice): Promise<{ ok: true }> {
    this.assertEnabled();
    await this.engine.setDevice(tabId, device);
    await this.publishTabs();
    return { ok: true };
  }

  async elementAt(tabId: string, query: BrowserElementQuery): Promise<BrowserElement> {
    this.assertEnabled();
    const point = query.at ?? query.hover;
    if (!point) throw new Error("elements query requires { at:[x,y] } or { hover:[x,y] }");
    return this.engine.elementAt(tabId, point[0], point[1]);
  }

  async wait(tabId: string, req: BrowserWaitRequest): Promise<BrowserWaitResponse> {
    this.assertEnabled();
    const started = Date.now();
    const deadline = started + req.timeoutMs;
    if (req.forMs != null) {
      await sleep(Math.min(req.forMs, req.timeoutMs));
      return { ok: true, timedOut: false, elapsedMs: Date.now() - started };
    }
    if (req.forText == null && req.forRef == null) {
      throw new Error("wait requires forText, forRef, or forMs");
    }
    for (;;) {
      const hit = req.forText != null
        ? await this.engine.textPresent(tabId, req.forText)
        : await this.engine.refVisible(tabId, req.forRef!).catch(() => false);
      if (hit) return { ok: true, timedOut: false, elapsedMs: Date.now() - started };
      if (Date.now() + WAIT_POLL_MS > deadline) {
        return { ok: false, timedOut: true, elapsedMs: Date.now() - started };
      }
      await sleep(WAIT_POLL_MS);
    }
  }

  async setMuted(tabId: string, muted: boolean): Promise<{ ok: true }> {
    this.assertEnabled();
    await this.engine.setMuted(tabId, muted);
    await this.publishTabs();
    return { ok: true };
  }

  // ---- frames ----------------------------------------------------------------

  // Frame fan-out with per-tab refcounting: the engine screencast starts with
  // the first subscriber and stops with the last, so a hidden panel (pause /
  // close) costs 0 bytes and ~0 CPU (the stream is damage-driven).
  async subscribeFrames(tabId: string, display: DisplaySize, onFrame: (frame: BrowserFrame) => void): Promise<() => void> {
    this.assertEnabled();
    let set = this.subscribers.get(tabId);
    if (!set) {
      set = new Set();
      this.subscribers.set(tabId, set);
      const fanout = set;
      await this.engine.startScreencast(tabId, display, (frame) => {
        for (const fn of fanout) fn(frame);
      });
      // A viewer is back — lift the system-level silence (user mute, if any,
      // stays: effective mute is user OR silence, engine-side).
      void this.engine.setSilenced(tabId, false).catch(() => {});
    }
    set.add(onFrame);
    return () => {
      const s = this.subscribers.get(tabId);
      if (!s) return;
      s.delete(onFrame);
      if (s.size === 0) {
        this.subscribers.delete(tabId);
        void this.engine.stopScreencast(tabId).catch((e) => {
          this.log.warn("stopScreencast failed", { tabId, error: e instanceof Error ? e.message : String(e) });
        });
        // AUDIO: stopping the screencast does NOT stop sound — playback keeps
        // going (verified by the audio spike, even across a viewer crash). Both
        // no-viewer paths (WS pause = panel hidden, WS close = panel closed)
        // converge here, so this is where the tab must fall silent.
        this.silenceTab(tabId);
      }
    };
  }

  // The panel resized — re-apply its display size to the live stream: RESPONSIVE
  // re-emulates the viewport and restarts at the new native resolution; fixed
  // profiles (Mobile/Tablet) ignore it. Does not touch the subscriber refcount,
  // so a resize never blips audio.
  async resizeViewport(tabId: string, display: DisplaySize): Promise<void> {
    this.assertEnabled();
    await this.engine.setDisplaySize(tabId, display);
  }

  async input(tabId: string, event: BrowserInputEvent): Promise<void> {
    this.assertEnabled();
    await this.engine.dispatchInput(tabId, event);
  }

  viewport(tabId?: string): { width: number; height: number } {
    return this.engine.viewport(tabId);
  }

  dispose(): void {
    this.subscribers.clear();
    this.engine.dispose();
  }

  // ---- policy ----------------------------------------------------------------

  // Per-navigation origin allowlist — AGENTS ONLY. The human driving their own
  // panel is not the threat model, so a "human" (ui-token) navigation is never
  // fenced; an agent navigation is restricted to browser.allowedOrigins when
  // that list is non-empty. Empty list (the default) = no restriction. An
  // entry is a full origin ("https://example.com") or a bare host
  // ("example.com", any http(s) scheme, exact host match).
  enforceNavPolicy(url: string, actor: BrowserActor = "agent"): void {
    if (actor === "human") return;
    const allowed = this.getConfig().allowedOrigins;
    if (!allowed.length) return;
    if (url === "about:blank") return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BrowserNavBlockedError(`navigation blocked: ${JSON.stringify(url)} is not a valid URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrowserNavBlockedError(`navigation blocked: ${parsed.protocol} URLs are not allowed while browser.allowedOrigins is set`);
    }
    const ok = allowed.some((entry) => {
      const e = entry.trim().toLowerCase();
      if (!e) return false;
      if (e.includes("://")) return e === parsed.origin.toLowerCase();
      return e === parsed.host.toLowerCase() || e === parsed.hostname.toLowerCase();
    });
    if (!ok) {
      throw new BrowserNavBlockedError(
        `navigation blocked: ${parsed.origin} is not in browser.allowedOrigins — agent navigation is restricted to that list; the operator can navigate the panel by hand or extend the allowlist`,
      );
    }
  }

  // Strip credential-bearing headers from anything that can reach a tool
  // result. Values are replaced, never dropped, so the caller still sees WHICH
  // headers existed.
  redactHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      out[k] = SENSITIVE_HEADER_RE.test(k) ? "[redacted]" : v;
    }
    return out;
  }

  // Agent egress chokepoint: routes pass every agent-bound response through
  // here, and any `…headers` map anywhere in the payload is redacted. Human/UI
  // responses never come through. No current response shape carries headers —
  // this seam is what keeps a future one from leaking credentials into a tool
  // result.
  redactForAgent<T>(payload: T): T {
    return this.redactValue(payload) as T;
  }

  private redactValue(v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.redactValue(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = /headers$/i.test(k) && isStringRecord(val) ? this.redactHeaders(val) : this.redactValue(val);
      }
      return out;
    }
    return v;
  }

  // A tab nobody is viewing must not keep making sound — audio provably keeps
  // playing after Page.stopScreencast (audio spike). System-level silence;
  // user-level mute is separate and survives it.
  silenceTab(tabId: string): void {
    void this.engine.setSilenced(tabId, true).catch((e) => {
      this.log.warn("silenceTab failed", { tabId, error: e instanceof Error ? e.message : String(e) });
    });
  }

  // ---- internals -------------------------------------------------------------

  private async withOptionalSnapshot(tabId: string, include: boolean): Promise<{ ok: true; snapshot?: BrowserSnapshotResponse }> {
    if (!include) return { ok: true };
    const snapshot = await this.snapshot(tabId, { interactiveOnly: true } as BrowserSnapshotRequest);
    return { ok: true, snapshot };
  }

  private assertEnabled(): void {
    if (!this.getConfig().enabled) throw new BrowserDisabledError();
  }

  private stateOf(): BrowserStatus["state"] {
    if (!this.getConfig().enabled) return "disabled";
    if (this.engine.isRunning()) return "running";
    if (this.launching) return "launching";
    if (this.crashed) return "crashed";
    if (!this.engine.binaryPath()) return "absent";
    // Not yet launched, binary present. The contract enum has no idle/stopped
    // state (flagged upstream); "launching" is the closest not-running-yet value
    // and the panel's flow (POST /browser/launch on open) never waits on it.
    return "launching";
  }

  private publishStatus(): void {
    this.bus.publish("browser:status", this.status());
  }

  private async publishTabs(): Promise<void> {
    try {
      const tabs = await this.listTabs();
      this.tabCount = tabs.length;
      this.bus.publish("browser:tabs", { tabs });
    } catch (e) {
      this.log.warn("browser tab publish failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return !!v && typeof v === "object" && !Array.isArray(v)
    && Object.values(v).every((x) => typeof x === "string");
}
