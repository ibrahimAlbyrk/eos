import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserService, BrowserDisabledError, BrowserNavBlockedError, NEW_TAB_URL } from "../BrowserService.ts";
import { BrowserTabSchema } from "../../../contracts/src/browser.ts";
import type { BrowserEngine, BrowserEngineTabInfo, BrowserFrame, DisplaySize } from "../../../core/src/ports/BrowserEngine.ts";

// The panel's live display size the daemon streams against (Responsive 1:1).
const DISPLAY: DisplaySize = { cssWidth: 1280, cssHeight: 800, dpr: 2 };

const log = { info: () => {}, warn: () => {} };

function makeBus() {
  const published: Array<{ topic: string; payload: unknown }> = [];
  return {
    published,
    publish: (topic: string, payload: unknown) => published.push({ topic, payload }),
    subscribe: () => () => {},
  };
}

class FakeEngine implements BrowserEngine {
  running = false;
  tabs: BrowserEngineTabInfo[] = [];
  screencasts = new Map<string, (f: BrowserFrame) => void>();
  startCalls = 0;
  stopCalls = 0;
  inputs: unknown[] = [];
  silencedCalls: Array<[string, boolean]> = [];
  displaySizeCalls: Array<[string, DisplaySize]> = [];
  textPresentResult = false;
  private exitCb: ((info: { code: number | null }) => void) | null = null;
  private nextId = 0;
  // Mirrors the adapter's foregroundTabId: set on openTab (new tab foregrounds)
  // and on startScreencast (a subscribe brings its tab to front), cleared when
  // the foreground tab closes.
  active: string | null = null;

  async launch() { this.running = true; }
  isRunning() { return this.running; }
  binaryPath() { return "/fake/chrome"; }
  async openTab(url: string) {
    const tabId = `bt-${++this.nextId}`;
    this.tabs.push({ tabId, url, title: "t", loading: false, canGoBack: false, canGoForward: false, audible: false, muted: false });
    this.active = tabId;
    return tabId;
  }
  async closeTab(tabId: string) {
    this.tabs = this.tabs.filter((t) => t.tabId !== tabId);
    if (this.active === tabId) this.active = null;
  }
  async listTabs() { return this.tabs; }
  activeTabId() { return this.active && this.tabs.some((t) => t.tabId === this.active) ? this.active : null; }
  async navigate() {}
  async startScreencast(tabId: string, _p: unknown, onFrame: (f: BrowserFrame) => void) {
    this.startCalls++;
    this.active = tabId;
    this.screencasts.set(tabId, onFrame);
  }
  async stopScreencast(tabId: string) { this.stopCalls++; this.screencasts.delete(tabId); }
  async setDisplaySize(tabId: string, display: DisplaySize) { this.displaySizeCalls.push([tabId, display]); }
  async dispatchInput(_tabId: string, event: unknown) { this.inputs.push(event); }
  viewport() { return { width: 1280, height: 800 }; }
  async snapshot() { return { url: "u", snapshot: "" }; }
  async find() { return []; }
  async act() {}
  async typeText() {}
  async press() {}
  async scroll() {}
  async get() { return ""; }
  async capture() { return new Uint8Array([0xff, 0xd8]); }
  async setDevice() {}
  async elementAt() { return { ref: "@e1", tag: "a", role: "link", name: "x", box: [0, 0, 1, 1] as [number, number, number, number], focusable: true, locator: "role=link" }; }
  async textPresent() { return this.textPresentResult; }
  async refVisible() { return false; }
  async setMuted() {}
  async setSilenced(tabId: string, silenced: boolean) { this.silencedCalls.push([tabId, silenced]); }
  onExit(cb: (info: { code: number | null }) => void) { this.exitCb = cb; }
  dispose() { this.running = false; }
  crash() { this.running = false; this.exitCb?.({ code: 1 }); }
}

function make(enabled = true, allowedOrigins: string[] = []) {
  const engine = new FakeEngine();
  const bus = makeBus();
  const service = new BrowserService({
    engine,
    getConfig: () => ({ enabled, chromePath: null, allowedOrigins, persistProfile: true }),
    bus,
    log,
  });
  return { engine, bus, service };
}

test("disabled config gates every entry point", async () => {
  const { service, engine } = make(false);
  assert.equal(service.status().state, "disabled");
  await assert.rejects(() => service.ensureLaunched(), BrowserDisabledError);
  await assert.rejects(() => service.openTab(), BrowserDisabledError);
  await assert.rejects(() => service.listTabs(), BrowserDisabledError);
  await assert.rejects(() => service.snapshot("bt-1", { interactiveOnly: true }), BrowserDisabledError);
  await assert.rejects(() => service.subscribeFrames("bt-1", DISPLAY, () => {}), BrowserDisabledError);
  await assert.rejects(() => service.input("bt-1", { kind: "insert", text: "x" }), BrowserDisabledError);
  assert.throws(() => service.activeTabId(), BrowserDisabledError);
  assert.equal(engine.running, false); // nothing launched
});

test("openTab launches once and opens a blank tab (no hardcoded start site)", async () => {
  const { service, engine } = make();
  const tabId = await service.openTab();
  assert.ok(tabId.startsWith("bt-"));
  assert.equal(NEW_TAB_URL, "about:blank"); // the old example.com default is gone
  assert.equal(engine.tabs[0].url, NEW_TAB_URL);
  assert.equal(service.status().state, "running");
});

test("activeTabId is the foreground tab: newest open, follows a subscribe, cleared on its close", async () => {
  const { service } = make();
  assert.equal(service.activeTabId(), null); // nothing open yet
  const a = await service.openTab();
  const b = await service.openTab();
  assert.equal(service.activeTabId(), b, "the newest open tab is the foreground");
  // Subscribing to A is the panel switching to A → it becomes the foreground.
  await service.subscribeFrames(a, DISPLAY, () => {});
  assert.equal(service.activeTabId(), a);
  await service.closeTab(a);
  assert.equal(service.activeTabId(), null, "closing the foreground clears it — no first-tab fallback");
});

test("tab objects parse against BrowserTabSchema (audible/muted present)", async () => {
  const { service } = make();
  await service.openTab();
  const tabs = await service.listTabs();
  for (const t of tabs) {
    const parsed = BrowserTabSchema.parse(t);
    assert.equal(parsed.audible, false);
    assert.equal(parsed.muted, false);
  }
});

test("frame subscription refcounts: one screencast per tab, stopped on last unsubscribe", async () => {
  const { service, engine } = make();
  const silenced: string[] = [];
  service.silenceTab = (tabId: string) => silenced.push(tabId);
  const tabId = await service.openTab();
  const seen: BrowserFrame[] = [];
  const un1 = await service.subscribeFrames(tabId, DISPLAY, (f) => seen.push(f));
  const un2 = await service.subscribeFrames(tabId, DISPLAY, () => {});
  assert.equal(engine.startCalls, 1);
  // The first subscriber lifts the system-level silence (viewer is back).
  assert.deepEqual(engine.silencedCalls, [[tabId, false]]);
  engine.screencasts.get(tabId)?.({ tabId, data: new Uint8Array([1]), width: 2, height: 2 });
  assert.equal(seen.length, 1);
  un1();
  assert.equal(engine.stopCalls, 0); // one subscriber left
  assert.deepEqual(silenced, []);
  un2();
  assert.equal(engine.stopCalls, 1);
  // Audio outlives the screencast (audio spike) — the last-viewer path must
  // hit the silenceTab seam.
  assert.deepEqual(silenced, [tabId]);
});

test("resizeViewport forwards the panel display size to the engine", async () => {
  const { service, engine } = make();
  const tabId = await service.openTab();
  await service.resizeViewport(tabId, { cssWidth: 900, cssHeight: 600, dpr: 2 });
  assert.deepEqual(engine.displaySizeCalls, [[tabId, { cssWidth: 900, cssHeight: 600, dpr: 2 }]]);
});

test("silenceTab drives engine.setSilenced(true)", async () => {
  const { service, engine } = make();
  const tabId = await service.openTab();
  service.silenceTab(tabId);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(engine.silencedCalls, [[tabId, true]]);
});

test("engine crash flips status and clears subscribers", async () => {
  const { service, engine, bus } = make();
  const tabId = await service.openTab();
  await service.subscribeFrames(tabId, DISPLAY, () => {});
  engine.crash();
  assert.equal(service.status().state, "crashed");
  assert.ok(bus.published.some((p) => p.topic === "browser:status"));
});

test("navigate url action requires a url", async () => {
  const { service } = make();
  const tabId = await service.openTab();
  await assert.rejects(() => service.navigate(tabId, { action: "url" }), /requires a url/);
});

test("enforceNavPolicy: empty allowlist allows everything", () => {
  const { service } = make(true, []);
  service.enforceNavPolicy("https://anything.example");
  service.enforceNavPolicy("about:blank");
});

test("enforceNavPolicy: non-empty allowlist blocks outside origins", async () => {
  const { service } = make(true, ["https://example.com", "docs.example.org"]);
  service.enforceNavPolicy("https://example.com/page"); // full-origin entry
  service.enforceNavPolicy("http://docs.example.org/x"); // bare-host entry, any scheme
  service.enforceNavPolicy("about:blank"); // always allowed
  assert.throws(() => service.enforceNavPolicy("https://evil.example"), BrowserNavBlockedError);
  assert.throws(() => service.enforceNavPolicy("http://example.com.evil.net"), BrowserNavBlockedError);
  assert.throws(() => service.enforceNavPolicy("file:///etc/passwd"), BrowserNavBlockedError);
  assert.throws(() => service.enforceNavPolicy("not a url"), BrowserNavBlockedError);
  // ...and the same gate runs on openTab/navigate.
  await assert.rejects(() => service.openTab("https://evil.example"), BrowserNavBlockedError);
});

test("redactHeaders strips the credential family, keeps the rest", () => {
  const { service } = make();
  const out = service.redactHeaders({
    Authorization: "Bearer abc",
    Cookie: "sid=1",
    "Set-Cookie": "sid=1",
    "X-Api-Key": "k",
    "X-Auth-Token": "t",
    "Session-Id": "s",
    "Content-Type": "text/html",
    Accept: "*/*",
  });
  assert.equal(out.Authorization, "[redacted]");
  assert.equal(out.Cookie, "[redacted]");
  assert.equal(out["Set-Cookie"], "[redacted]");
  assert.equal(out["X-Api-Key"], "[redacted]");
  assert.equal(out["X-Auth-Token"], "[redacted]");
  assert.equal(out["Session-Id"], "[redacted]");
  assert.equal(out["Content-Type"], "text/html");
  assert.equal(out.Accept, "*/*");
});

test("enforceNavPolicy is asymmetric: the human bypasses the allowlist, the agent (and the default) is fenced", async () => {
  const { service } = make(true, ["example.com"]);
  service.enforceNavPolicy("https://evil.example", "human"); // no throw
  assert.throws(() => service.enforceNavPolicy("https://evil.example", "agent"), BrowserNavBlockedError);
  assert.throws(() => service.enforceNavPolicy("https://evil.example"), BrowserNavBlockedError); // omitted actor fails closed
  const tabId = await service.openTab("https://evil.example", "human");
  await service.navigate(tabId, { action: "url", url: "https://evil.example" }, "human");
  await assert.rejects(() => service.navigate(tabId, { action: "url", url: "https://evil.example" }, "agent"), BrowserNavBlockedError);
});

test("redactForAgent strips header maps anywhere in the payload, leaves everything else", () => {
  const { service } = make();
  const out = service.redactForAgent({
    tabId: "bt-1",
    responseHeaders: { Authorization: "Bearer abc", "Content-Type": "text/html" },
    nested: [{ requestHeaders: { Cookie: "sid=1", Accept: "*/*" } }],
    headers: "not-a-map", // non-record `headers` value stays untouched
    count: 3,
  });
  assert.equal(out.responseHeaders.Authorization, "[redacted]");
  assert.equal(out.responseHeaders["Content-Type"], "text/html");
  assert.equal(out.nested[0].requestHeaders.Cookie, "[redacted]");
  assert.equal(out.nested[0].requestHeaders.Accept, "*/*");
  assert.equal(out.headers, "not-a-map");
  assert.equal(out.count, 3);
});

test("wait: forMs sleeps, forText polls to timeout", async () => {
  const { service, engine } = make();
  const tabId = await service.openTab();
  const quick = await service.wait(tabId, { forMs: 30, timeoutMs: 1000 });
  assert.equal(quick.ok, true);
  const miss = await service.wait(tabId, { forText: "never", timeoutMs: 300 });
  assert.equal(miss.ok, false);
  assert.equal(miss.timedOut, true);
  engine.textPresentResult = true;
  const hit = await service.wait(tabId, { forText: "now", timeoutMs: 1000 });
  assert.equal(hit.ok, true);
});
