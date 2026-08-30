import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  BrowserService,
  BrowserDisabledError,
  BrowserNavBlockedError,
  NEW_TAB_URL,
  PRESENT_RATE_LIMIT_MS,
  browserProfileDirFor,
} from "../BrowserService.ts";
import { BrowserTabSchema, GLOBAL_SESSION } from "../../../contracts/src/browser.ts";
import type { BrowserEngine, BrowserEngineTabInfo } from "../../../core/src/ports/BrowserEngine.ts";

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
  disposed = false;
  tabs: BrowserEngineTabInfo[] = [];
  textPresentResult = false;
  private exitCb: ((info: { code: number | null }) => void) | null = null;
  private static nextId = 0;
  // Mirrors the adapter's foregroundTabId: set on openTab (new tab foregrounds),
  // cleared when the foreground tab closes.
  active: string | null = null;

  async launch() { this.running = true; }
  isRunning() { return this.running; }
  binaryPath() { return "/fake/chrome"; }
  async openTab(url: string) {
    const tabId = `bt-${++FakeEngine.nextId}`;
    this.tabs.push({ tabId, url, title: "t", loading: false, canGoBack: false, canGoForward: false, audible: false, muted: false, faviconDataUri: null });
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
  onExit(cb: (info: { code: number | null }) => void) { this.exitCb = cb; }
  onTabsChanged() {}
  dispose() { this.running = false; this.disposed = true; }
  crash() { this.running = false; this.exitCb?.({ code: 1 }); }
}

function make(enabled = true, allowedOrigins: string[] = [], perSession = true) {
  const engines = new Map<string, FakeEngine>();
  const bus = makeBus();
  const service = new BrowserService({
    engineFactory: (sessionKey) => {
      const e = new FakeEngine();
      engines.set(sessionKey, e);
      return e;
    },
    getConfig: () => ({ enabled, chromePath: null, allowedOrigins, persistProfile: true, perSession }),
    bus,
    log,
  });
  // Wave-1-shaped accessor: most tests exercise the global session's engine.
  const engineFor = (key: string = GLOBAL_SESSION): FakeEngine => {
    const e = engines.get(key);
    assert.ok(e, `no engine created for session ${key}`);
    return e;
  };
  return { engines, engineFor, bus, service };
}


test("disabled config gates every entry point", async () => {
  const { service, engines } = make(false);
  assert.equal(service.status().state, "disabled");
  await assert.rejects(() => service.ensureLaunched(), BrowserDisabledError);
  await assert.rejects(() => service.openTab(), BrowserDisabledError);
  await assert.rejects(() => service.listTabs(), BrowserDisabledError);
  await assert.rejects(() => service.snapshot("bt-x", { interactiveOnly: true }), BrowserDisabledError);
  assert.throws(() => service.activeTabId(), BrowserDisabledError);
  // Nothing launched — no session ever got a running engine (the status probe
  // may construct an engine object, but never launches it).
  for (const e of engines.values()) assert.equal(e.running, false);
});

test("openTab launches once and opens a blank tab (no hardcoded start site)", async () => {
  const { service, engineFor } = make();
  const tabId = await service.openTab();
  assert.ok(tabId.startsWith("bt-"));
  assert.equal(NEW_TAB_URL, "about:blank"); // the old example.com default is gone
  assert.equal(engineFor().tabs[0].url, NEW_TAB_URL);
  assert.equal(service.status().state, "running");
});

test("activeTabId: newest open, explicit setActiveTab pointer, cleared on close (no first-tab fallback)", async () => {
  const { service } = make();
  assert.equal(service.activeTabId(), null); // nothing open yet
  const a = await service.openTab();
  const b = await service.openTab();
  assert.equal(service.activeTabId(), b, "the newest open tab is the active one");
  // The panel declaring it shows A (setActiveTab) makes A the session's active tab.
  service.setActiveTab(GLOBAL_SESSION, a);
  assert.equal(service.activeTabId(), a);
  await service.closeTab(b); // A is still the pointer and open
  assert.equal(service.activeTabId(), a);
  await service.closeTab(a); // close the active tab itself
  assert.equal(service.activeTabId(), null, "closing the active tab clears it — no fallback to a remaining tab");
});

test("tab objects parse against BrowserTabSchema (sessionId/audible/muted present)", async () => {
  const { service } = make();
  await service.openTab();
  const tabs = await service.listTabs();
  assert.ok(tabs.length > 0);
  for (const t of tabs) {
    const parsed = BrowserTabSchema.parse(t);
    assert.equal(parsed.sessionId, GLOBAL_SESSION);
    assert.equal(parsed.audible, false);
    assert.equal(parsed.muted, false);
  }
});

// ---- per-session engines -----------------------------------------------------

test("two session keys get distinct engines and disjoint listTabs", async () => {
  const { service, engines } = make();
  const t1 = await service.openTab("about:blank", "agent", "o-a");
  const t2 = await service.openTab("about:blank", "agent", "o-b");
  assert.equal(engines.get("o-a")!.running, true);
  assert.equal(engines.get("o-b")!.running, true);
  assert.notEqual(engines.get("o-a"), engines.get("o-b"));
  const tabsA = await service.listTabs("o-a");
  const tabsB = await service.listTabs("o-b");
  assert.deepEqual(tabsA.map((t) => t.tabId), [t1]);
  assert.deepEqual(tabsB.map((t) => t.tabId), [t2]);
  assert.ok(tabsA.every((t) => t.sessionId === "o-a"));
  assert.ok(tabsB.every((t) => t.sessionId === "o-b"));
  assert.equal(service.sessionOfTab(t1), "o-a");
  assert.equal(service.sessionOfTab(t2), "o-b");
  assert.equal(service.sessionOfTab("bt-ghost"), null);
  // Per-session active pointers never cross.
  assert.equal(service.activeTabId("o-a"), t1);
  assert.equal(service.activeTabId("o-b"), t2);
  assert.equal(service.activeTabId(), null, "the global session has no tab");
});

test("perSession:false maps every session key onto the one global engine", async () => {
  const { service, engines } = make(true, [], false);
  const t1 = await service.openTab("about:blank", "agent", "o-a");
  const t2 = await service.openTab("about:blank", "agent", "o-b");
  assert.equal(engines.size, 1);
  assert.ok(engines.has(GLOBAL_SESSION));
  const tabs = await service.listTabs("o-a");
  assert.deepEqual(tabs.map((t) => t.tabId), [t1, t2], "both tabs live in the shared session");
  assert.ok(tabs.every((t) => t.sessionId === GLOBAL_SESSION));
  assert.equal(service.sessionOfTab(t1), GLOBAL_SESSION);
  // Root death never disposes the shared browser.
  service.disposeSession("o-a");
  assert.equal(engines.get(GLOBAL_SESSION)!.disposed, false);
  assert.equal((await service.listTabs("o-b")).length, 2);
});

test("disposeSession tears down exactly that session's engine; profile-backed relaunch gets a fresh one", async () => {
  const { service, engines, bus } = make();
  const t1 = await service.openTab("about:blank", "agent", "o-a");
  await service.openTab("about:blank", "agent", "o-b");
  const engineA = engines.get("o-a")!;
  service.disposeSession("o-a");
  assert.equal(engineA.disposed, true);
  assert.equal(engines.get("o-b")!.disposed, false, "the other session's Chrome is untouched");
  assert.equal(service.sessionOfTab(t1), null, "disposed session's tab mappings dropped");
  assert.deepEqual(await service.listTabs("o-a"), []);
  const cleared = bus.published.find((p) => p.topic === "browser:tabs" && (p.payload as { sessionId?: string }).sessionId === "o-a" && (p.payload as { tabs: unknown[] }).tabs.length === 0);
  assert.ok(cleared, "an empty browser:tabs is published so the panel clears");
  // Next use lazily relaunches a NEW engine for the same key.
  await service.openTab("about:blank", "agent", "o-a");
  assert.notEqual(engines.get("o-a"), engineA);
  assert.equal(engines.get("o-a")!.running, true);
});

test("browser profile dirs: global keeps the wave-1 dir, sessions live beside it, keys are sanitized", () => {
  assert.equal(browserProfileDirFor("/home/u/.eos", true, GLOBAL_SESSION), join("/home/u/.eos", "browser", "profile"));
  assert.equal(browserProfileDirFor("/home/u/.eos", true, "o-abc12"), join("/home/u/.eos", "browser", "o-abc12"));
  // A hostile/garbage key can never traverse out of the family.
  assert.equal(browserProfileDirFor("/home/u/.eos", true, "../../etc"), join("/home/u/.eos", "browser", ".._.._etc"));
  // persistProfile=false → throwaway per-boot dirs outside the home.
  assert.ok(!browserProfileDirFor("/home/u/.eos", false, "o-abc12").startsWith("/home/u/.eos"));
});

test("presentAllowed: one present per session per rate window", () => {
  const { service } = make();
  assert.equal(service.presentAllowed("o-a", 1000), true);
  assert.equal(service.presentAllowed("o-a", 1000 + PRESENT_RATE_LIMIT_MS - 1), false);
  assert.equal(service.presentAllowed("o-b", 1500), true, "other sessions are unaffected");
  assert.equal(service.presentAllowed("o-a", 1000 + PRESENT_RATE_LIMIT_MS), true);
});

test("publishActivity collapses the session key under perSession:false", () => {
  const { service, bus } = make(true, [], false);
  service.publishActivity({ sessionId: "o-a", workerId: "w-1", kind: "use", tabId: "bt-1" });
  const msg = bus.published.find((p) => p.topic === "browser:activity");
  assert.ok(msg);
  assert.equal((msg.payload as { sessionId: string }).sessionId, GLOBAL_SESSION);
});

test("one session's engine crash clears only that session's state", async () => {
  const { service, engines } = make();
  const t1 = await service.openTab("about:blank", "agent", "o-a");
  const t2 = await service.openTab("about:blank", "agent", "o-b");
  engines.get("o-a")!.crash();
  assert.equal(service.status("o-a").state, "crashed");
  assert.equal(service.status("o-b").state, "running");
  assert.equal(service.sessionOfTab(t1), null);
  assert.equal(service.sessionOfTab(t2), "o-b");
});

test("engine crash flips status to crashed and publishes it", async () => {
  const { service, engineFor, bus } = make();
  await service.openTab();
  engineFor().crash();
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
  const { service, engineFor } = make();
  const tabId = await service.openTab();
  const quick = await service.wait(tabId, { forMs: 30, timeoutMs: 1000 });
  assert.equal(quick.ok, true);
  const miss = await service.wait(tabId, { forText: "never", timeoutMs: 300 });
  assert.equal(miss.ok, false);
  assert.equal(miss.timedOut, true);
  engineFor().textPresentResult = true;
  const hit = await service.wait(tabId, { forText: "now", timeoutMs: 1000 });
  assert.equal(hit.ok, true);
});
