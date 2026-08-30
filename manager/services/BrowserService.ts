// BrowserService — daemon-side owner of the per-session Chromes (engine
// supervision + tab registry + frame fan-out + nav policy). A "session" is the
// parent-chain ROOT worker id (or GLOBAL_SESSION); each session gets its OWN
// persistent Chrome process, launched lazily on first browser use, with its own
// on-disk profile dir so logins survive a daemon restart. Humans reach it
// through routes/browser.ts + the /browser/stream WS; agents reach their
// session's browser through the browser_* tools. Chrome plays audio straight to
// the system output device — only pictures travel over CDP.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { BrowserEngine } from "../../core/src/ports/BrowserEngine.ts";
import type {
  BrowserActivity,
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
import { GLOBAL_SESSION } from "../../contracts/src/browser.ts";

export interface BrowserConfigSlice {
  enabled: boolean;
  chromePath: string | null;
  allowedOrigins: string[];
  persistProfile: boolean;
  // false restores the wave-1 single shared browser: every sessionKey maps to
  // the one GLOBAL_SESSION engine (and root death never disposes it).
  perSession: boolean;
}

// Who is driving. Derived SERVER-SIDE in routes/browser.ts from headers alone
// (ui token ⇒ the human panel; x-eos-agent-id ⇒ that agent) — never read from
// a request body, so an agent cannot claim to be the human. Defaults below are
// "agent" (fail closed): a caller that forgets to declare gets the fenced
// experience.
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

// Request/response headers that must never reach a tool result. Exact
// credential carriers plus the token/api-key naming family.
const SENSITIVE_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|session|auth/i;

const WAIT_POLL_MS = 250;

// browser_show nag guard: a second present for the same session within this
// window is dropped (the panel was just surfaced; re-surfacing is pure noise).
export const PRESENT_RATE_LIMIT_MS = 3000;

// Debounce for engine-initiated tab changes (title ticks, SPA navigations,
// favicon resolution) before re-publishing that session's browser:tabs.
const TABS_CHANGED_DEBOUNCE_MS = 250;

// Where a session's Chrome keeps its on-disk profile (cookies/logins).
// GLOBAL_SESSION keeps the wave-1 dir (<home>/browser/profile) so existing
// logins survive the per-session split; other sessions live beside it at
// <home>/browser/<sessionKey>. persistProfile=false → throwaway per-boot dirs
// in the OS temp dir. The key is sanitized before touching the filesystem —
// real keys are repo-validated worker ids, but a human-declared ?session= is
// free-form and must never traverse out of the family.
export function browserProfileDirFor(home: string, persistProfile: boolean, sessionKey: string): string {
  const safe = sessionKey === GLOBAL_SESSION ? "profile" : sessionKey.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!persistProfile) return join(tmpdir(), `eos-browser-${process.pid}-${safe}`);
  return join(home, "browser", safe);
}

// One session's engine + its launch latch, crash flag and tab count. The engine
// instance carries its own Chrome child / keep-alive target (headless lane) or
// the remote channel (embedded lane).
interface EngineSlot {
  sessionKey: string;
  engine: BrowserEngine;
  launching: Promise<void> | null;
  crashed: boolean;
  tabCount: number;
}

export class BrowserService {
  private engineFactory: (sessionKey: string) => BrowserEngine;
  private getConfig: () => BrowserConfigSlice;
  private bus: EventBus;
  private log: Log;
  private slots = new Map<string, EngineSlot>();
  // tabId → owning sessionKey. tabIds are engine-minted (bt-<random>) and
  // unique across engines, so one flat map serves every reverse lookup.
  private tabSessions = new Map<string, string>();
  // Per-session "this page" — the tab an omitted tabId resolves to. Updated by
  // the panel's subscribe (the human looking at a tab), an agent's openTab, and
  // browser_show. Falls back to the session engine's live foreground.
  private activeBySession = new Map<string, string>();
  private lastPresentAt = new Map<string, number>();
  private tabsPublishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Binary probe for status of sessions with no engine yet — an engine OBJECT
  // is cheap (Chrome only spawns on launch()), and binaryPath() is pure probing.
  private probeEngine: BrowserEngine | null = null;

  constructor(deps: {
    engineFactory: (sessionKey: string) => BrowserEngine;
    getConfig: () => BrowserConfigSlice;
    bus: EventBus;
    log: Log;
  }) {
    this.engineFactory = deps.engineFactory;
    this.getConfig = deps.getConfig;
    this.bus = deps.bus;
    this.log = deps.log;
  }

  // Collapse a caller's sessionKey onto the engine map: perSession=false is the
  // wave-1 single shared browser, so every key maps to GLOBAL_SESSION.
  resolveSessionKey(sessionKey: string): string {
    return this.getConfig().perSession ? sessionKey : GLOBAL_SESSION;
  }

  // The owning session of a live tab, or null when the tab is unknown (the
  // caller lets the engine produce its unknown-tab error → 404, not 403).
  sessionOfTab(tabId: string): string | null {
    return this.tabSessions.get(tabId) ?? null;
  }

  status(sessionKey: string = GLOBAL_SESSION): BrowserStatus {
    const key = this.resolveSessionKey(sessionKey);
    const slot = this.slots.get(key);
    return {
      state: slot ? this.stateOf(slot) : this.idleStateOf(),
      chromePath: (slot?.engine ?? this.probe()).binaryPath(),
      // Updated by publishTabs; 0 while the session's engine is down/absent.
      tabCount: slot?.engine.isRunning() ? slot.tabCount : 0,
      sessionId: key,
    };
  }

  async ensureLaunched(sessionKey: string = GLOBAL_SESSION): Promise<void> {
    this.assertEnabled();
    await this.ensureSlotLaunched(this.slotFor(sessionKey));
  }

  async openTab(url = NEW_TAB_URL, actor: BrowserActor = "agent", sessionKey: string = GLOBAL_SESSION): Promise<string> {
    this.assertEnabled();
    const slot = this.slotFor(sessionKey);
    await this.ensureSlotLaunched(slot);
    this.enforceNavPolicy(url, actor);
    const tabId = await slot.engine.openTab(url);
    this.tabSessions.set(tabId, slot.sessionKey);
    this.activeBySession.set(slot.sessionKey, tabId);
    await this.publishTabsFor(slot.sessionKey);
    return tabId;
  }

  async closeTab(tabId: string): Promise<void> {
    this.assertEnabled();
    const slot = this.slotOfTab(tabId);
    await slot.engine.closeTab(tabId);
    this.tabSessions.delete(tabId);
    if (this.activeBySession.get(slot.sessionKey) === tabId) this.activeBySession.delete(slot.sessionKey);
    await this.publishTabsFor(slot.sessionKey);
  }

  async listTabs(sessionKey: string = GLOBAL_SESSION): Promise<BrowserTab[]> {
    this.assertEnabled();
    const key = this.resolveSessionKey(sessionKey);
    const slot = this.slots.get(key);
    if (!slot || !slot.engine.isRunning()) return [];
    // audible comes live from the injected audio guard; muted is user-level.
    const tabs = await slot.engine.listTabs();
    return tabs.map((t) => ({ ...t, sessionId: key }));
  }

  // The session's "this page" — where an omitted tabId resolves. Prefers the
  // explicit per-session pointer (panel subscribe / agent openTab / show), falls
  // back to the session engine's live foreground; both validated against the
  // session's live tabs. null when nothing qualifies, which the route maps to a
  // clear "no active tab" rather than silently picking one.
  activeTabId(sessionKey: string = GLOBAL_SESSION): string | null {
    this.assertEnabled();
    const key = this.resolveSessionKey(sessionKey);
    const pointed = this.activeBySession.get(key);
    if (pointed && this.tabSessions.get(pointed) === key) return pointed;
    const fg = this.slots.get(key)?.engine.activeTabId() ?? null;
    return fg && this.tabSessions.get(fg) === key ? fg : null;
  }

  // Record a session's "look here" pointer (browser_show / explicit present).
  setActiveTab(sessionKey: string, tabId: string): void {
    this.activeBySession.set(this.resolveSessionKey(sessionKey), tabId);
  }

  // browser_show nag guard: true consumes the window; false = drop this present
  // (the same session presented less than PRESENT_RATE_LIMIT_MS ago).
  presentAllowed(sessionKey: string, now = Date.now()): boolean {
    const key = this.resolveSessionKey(sessionKey);
    const last = this.lastPresentAt.get(key);
    if (last != null && now - last < PRESENT_RATE_LIMIT_MS) return false;
    this.lastPresentAt.set(key, now);
    return true;
  }

  // SSE "an agent acted" signal (browser:activity) — the routes publish through
  // here so the session key is collapsed exactly like every engine lookup.
  publishActivity(activity: BrowserActivity): void {
    this.bus.publish("browser:activity", { ...activity, sessionId: this.resolveSessionKey(activity.sessionId) });
  }

  async navigate(tabId: string, req: BrowserNavigateRequest, actor: BrowserActor = "agent"): Promise<void> {
    this.assertEnabled();
    // Policy before tab resolution (wave-1 order): a blocked URL reads as 403
    // even when the tab is also unknown.
    if (req.action === "url") {
      if (!req.url) throw new Error("navigate action 'url' requires a url");
      this.enforceNavPolicy(req.url, actor);
    }
    const slot = this.slotOfTab(tabId);
    await slot.engine.navigate(tabId, req.action, req.url);
    await this.publishTabsFor(slot.sessionKey);
  }

  // ---- agent verbs -----------------------------------------------------------

  async snapshot(tabId: string, req: BrowserSnapshotRequest): Promise<BrowserSnapshotResponse> {
    this.assertEnabled();
    const r = await this.slotOfTab(tabId).engine.snapshot(tabId, {
      interactiveOnly: req.interactiveOnly,
      selector: req.selector,
      depth: req.depth,
    });
    return { tabId, url: r.url, snapshot: r.snapshot };
  }

  async find(tabId: string, query: string): Promise<BrowserFindResponse> {
    this.assertEnabled();
    const engine = this.slotOfTab(tabId).engine;
    const matches = await engine.find(tabId, query);
    return { tabId, url: await engine.get(tabId, "url"), matches };
  }

  async act(tabId: string, req: BrowserActRequest): Promise<{ ok: true; snapshot?: BrowserSnapshotResponse }> {
    this.assertEnabled();
    await this.slotOfTab(tabId).engine.act(tabId, req.ref, req.verb);
    return this.withOptionalSnapshot(tabId, req.includeSnapshot);
  }

  async typeText(tabId: string, req: BrowserTypeRequest): Promise<{ ok: true; snapshot?: BrowserSnapshotResponse }> {
    this.assertEnabled();
    await this.slotOfTab(tabId).engine.typeText(tabId, req.ref, req.text, req.submit);
    return this.withOptionalSnapshot(tabId, req.includeSnapshot);
  }

  async fillForm(tabId: string, req: BrowserFillFormRequest): Promise<{ ok: true }> {
    this.assertEnabled();
    const engine = this.slotOfTab(tabId).engine;
    for (const field of req.fields) {
      await engine.typeText(tabId, field.ref, field.value, false);
    }
    return { ok: true };
  }

  async press(tabId: string, req: BrowserPressRequest): Promise<{ ok: true }> {
    this.assertEnabled();
    await this.slotOfTab(tabId).engine.press(tabId, req.key);
    return { ok: true };
  }

  async scroll(tabId: string, req: BrowserScrollRequest): Promise<{ ok: true }> {
    this.assertEnabled();
    await this.slotOfTab(tabId).engine.scroll(tabId, req.direction, req.ref);
    return { ok: true };
  }

  async get(tabId: string, req: BrowserGetRequest): Promise<BrowserGetResponse> {
    this.assertEnabled();
    return { tabId, what: req.what, value: await this.slotOfTab(tabId).engine.get(tabId, req.what, req.ref) };
  }

  // JPEG bytes → temp file (same convention as POST /fs/paste): the MCP
  // channel is text-only, so bytes never travel as a return value.
  async capture(tabId: string, fullPage: boolean): Promise<{ path: string }> {
    this.assertEnabled();
    const bytes = await this.slotOfTab(tabId).engine.capture(tabId, fullPage);
    const dir = mkdtempSync(join(tmpdir(), "eos-paste-"));
    const path = join(dir, `browser-${tabId}-${Date.now()}.jpeg`);
    writeFileSync(path, bytes);
    return { path };
  }

  async setDevice(tabId: string, device: BrowserDevice): Promise<{ ok: true }> {
    this.assertEnabled();
    const slot = this.slotOfTab(tabId);
    await slot.engine.setDevice(tabId, device);
    await this.publishTabsFor(slot.sessionKey);
    return { ok: true };
  }

  async elementAt(tabId: string, query: BrowserElementQuery): Promise<BrowserElement> {
    this.assertEnabled();
    const point = query.at ?? query.hover;
    if (!point) throw new Error("elements query requires { at:[x,y] } or { hover:[x,y] }");
    return this.slotOfTab(tabId).engine.elementAt(tabId, point[0], point[1]);
  }

  async wait(tabId: string, req: BrowserWaitRequest): Promise<BrowserWaitResponse> {
    this.assertEnabled();
    const engine = this.slotOfTab(tabId).engine;
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
        ? await engine.textPresent(tabId, req.forText)
        : await engine.refVisible(tabId, req.forRef!).catch(() => false);
      if (hit) return { ok: true, timedOut: false, elapsedMs: Date.now() - started };
      if (Date.now() + WAIT_POLL_MS > deadline) {
        return { ok: false, timedOut: true, elapsedMs: Date.now() - started };
      }
      await sleep(WAIT_POLL_MS);
    }
  }

  async setMuted(tabId: string, muted: boolean): Promise<{ ok: true }> {
    this.assertEnabled();
    const slot = this.slotOfTab(tabId);
    await slot.engine.setMuted(tabId, muted);
    await this.publishTabsFor(slot.sessionKey);
    return { ok: true };
  }

  // Tear down ONE session's Chrome (root worker killed/archived/purged). The
  // profile dir stays on disk — the next use relaunches with logins intact.
  // No-op under perSession=false: the shared global browser outlives workers.
  disposeSession(sessionKey: string): void {
    if (!this.getConfig().perSession) return;
    const slot = this.slots.get(sessionKey);
    if (!slot) return;
    this.slots.delete(sessionKey);
    this.dropSessionState(sessionKey);
    slot.engine.dispose();
    this.publishStatus(sessionKey);
    this.publishEmptyTabs(sessionKey);
  }

  // A session whose engine just went away shows no tabs. Shared by disposeSession
  // and resetEngines.
  private publishEmptyTabs(sessionKey: string): void {
    this.bus.publish("browser:tabs", { sessionId: sessionKey, tabs: [] });
  }

  dispose(): void {
    for (const slot of this.slots.values()) slot.engine.dispose();
    this.slots.clear();
    this.tabSessions.clear();
    this.activeBySession.clear();
    for (const t of this.tabsPublishTimers.values()) clearTimeout(t);
    this.tabsPublishTimers.clear();
  }

  // Drop every live engine so the NEXT launch re-picks the engineFactory. The
  // browser host (the embedded app) changed — a registered host went away, so a
  // session's RemoteBrowserEngine is dead and its next use must fall back to the
  // headless CdpBrowserAdapter. Factory choice is per-launch (no live migration),
  // so this is just "forget everything and relaunch lazily". Each affected session
  // gets an empty tabs + a status publish so a watching panel updates immediately.
  resetEngines(): void {
    const keys = [...this.slots.keys()];
    for (const [, slot] of this.slots) slot.engine.dispose();
    this.slots.clear();
    this.tabSessions.clear();
    this.activeBySession.clear();
    this.lastPresentAt.clear();
    for (const t of this.tabsPublishTimers.values()) clearTimeout(t);
    this.tabsPublishTimers.clear();
    // The status probe may have cached the outgoing lane's engine — drop it so
    // status re-derives against the current factory.
    this.probeEngine = null;
    for (const key of keys) {
      this.publishStatus(key);
      this.publishEmptyTabs(key);
    }
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

  // ---- internals -------------------------------------------------------------

  // The session's engine slot, created on demand (the engine OBJECT is cheap;
  // its Chrome spawns only in ensureSlotLaunched). Wires the per-engine exit +
  // tab-change hooks exactly like wave-1 did for the single engine.
  private slotFor(sessionKey: string): EngineSlot {
    const key = this.resolveSessionKey(sessionKey);
    const existing = this.slots.get(key);
    if (existing) return existing;
    const slot: EngineSlot = {
      sessionKey: key,
      engine: this.engineFactory(key),
      launching: null,
      crashed: false,
      tabCount: 0,
    };
    slot.engine.onExit(({ code }) => {
      // A superseded engine (disposeSession → lazy relaunch) must not wipe the
      // successor slot's state when its child finally reports exit.
      if (this.slots.get(key) !== slot) return;
      slot.crashed = true;
      this.dropSessionState(key);
      this.log.warn("browser engine exited", { code, sessionId: key });
      this.publishStatus(key);
      this.bus.publish("browser:tabs", { sessionId: key, tabs: [] });
    });
    // Engine-initiated tab changes (title ticks, SPA navs, favicon, audible
    // edges) re-publish ONLY this session's tabs, debounced.
    slot.engine.onTabsChanged(() => this.schedulePublishTabs(key));
    this.slots.set(key, slot);
    return slot;
  }

  private async ensureSlotLaunched(slot: EngineSlot): Promise<void> {
    if (slot.engine.isRunning()) return;
    if (!slot.launching) {
      this.publishStatus(slot.sessionKey);
      slot.launching = slot.engine
        .launch()
        .then(() => {
          slot.crashed = false;
        })
        .finally(() => {
          slot.launching = null;
          this.publishStatus(slot.sessionKey);
        });
    }
    await slot.launching;
  }

  private slotOfTab(tabId: string): EngineSlot {
    const slot = this.slots.get(this.tabSessions.get(tabId) ?? "");
    if (!slot) throw new Error(`unknown tab: ${tabId}`);
    return slot;
  }

  // A session's tabs/pointers after its Chrome is gone (exit/dispose).
  private dropSessionState(sessionKey: string): void {
    for (const [tabId, key] of this.tabSessions) {
      if (key === sessionKey) this.tabSessions.delete(tabId);
    }
    this.activeBySession.delete(sessionKey);
    this.lastPresentAt.delete(sessionKey);
    const timer = this.tabsPublishTimers.get(sessionKey);
    if (timer) {
      clearTimeout(timer);
      this.tabsPublishTimers.delete(sessionKey);
    }
  }

  private probe(): BrowserEngine {
    const any = this.slots.values().next();
    if (!any.done) return any.value.engine;
    this.probeEngine ??= this.engineFactory(GLOBAL_SESSION);
    return this.probeEngine;
  }

  private async withOptionalSnapshot(tabId: string, include: boolean): Promise<{ ok: true; snapshot?: BrowserSnapshotResponse }> {
    if (!include) return { ok: true };
    const snapshot = await this.snapshot(tabId, { interactiveOnly: true } as BrowserSnapshotRequest);
    return { ok: true, snapshot };
  }

  private assertEnabled(): void {
    if (!this.getConfig().enabled) throw new BrowserDisabledError();
  }

  private stateOf(slot: EngineSlot): BrowserStatus["state"] {
    if (!this.getConfig().enabled) return "disabled";
    if (slot.engine.isRunning()) return "running";
    if (slot.launching) return "launching";
    if (slot.crashed) return "crashed";
    if (!slot.engine.binaryPath()) return "absent";
    // Not yet launched, binary present. The contract enum has no idle/stopped
    // state (flagged upstream); "launching" is the closest not-running-yet value
    // and the panel's flow (POST /browser/launch on open) never waits on it.
    return "launching";
  }

  // Status for a session with no engine yet (lazy — nothing launched): same
  // mapping as stateOf on a never-launched slot.
  private idleStateOf(): BrowserStatus["state"] {
    if (!this.getConfig().enabled) return "disabled";
    if (!this.probe().binaryPath()) return "absent";
    return "launching";
  }

  private publishStatus(sessionKey: string): void {
    this.bus.publish("browser:status", this.status(sessionKey));
  }

  private schedulePublishTabs(sessionKey: string): void {
    if (this.tabsPublishTimers.has(sessionKey)) return;
    const timer = setTimeout(() => {
      this.tabsPublishTimers.delete(sessionKey);
      void this.publishTabsFor(sessionKey);
    }, TABS_CHANGED_DEBOUNCE_MS);
    timer.unref?.();
    this.tabsPublishTimers.set(sessionKey, timer);
  }

  private async publishTabsFor(sessionKey: string): Promise<void> {
    try {
      const tabs = await this.listTabs(sessionKey);
      const slot = this.slots.get(this.resolveSessionKey(sessionKey));
      if (slot) slot.tabCount = tabs.length;
      this.bus.publish("browser:tabs", { sessionId: this.resolveSessionKey(sessionKey), tabs });
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
