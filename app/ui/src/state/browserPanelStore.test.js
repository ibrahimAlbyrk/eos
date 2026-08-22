import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { notify } from "../lib/notify.js";
import {
  subscribe, getBrowserPanel, patchBrowserPanel, refreshTabs, openTab, closeTab, switchTab,
  navigate, normalizeUrl, setUrlDraft, setMuted, toggleMode, resetPanelView, setDevice,
  applyTabs, applyStatus, isBlankUrl, withSession, bindPaneSession, _resetBrowserPanel,
} from "./browserPanelStore.js";

const readSrc = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// A tiny in-memory browser daemon over the real /browser routes: POST /tabs mints
// a tab, DELETE closes one, GET lists them, POST /tabs/:id/navigate moves the
// tab's url. Every request is recorded so the store's route choice is asserted
// for real, not mocked away.
function mockDaemon() {
  const tabs = [];
  const calls = [];
  let n = 0;
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const u = new URL(url);
    const path = u.pathname;
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ method, path, body, session: u.searchParams.get("session") });
    if (path === "/browser/tabs" && method === "GET") return res({ tabs: tabs.map((t) => ({ ...t })) });
    if (path === "/browser/tabs" && method === "POST") {
      n += 1;
      tabs.push({
        tabId: `t${n}`,
        url: body?.url ?? `https://start.example/${n}`,
        title: `Tab ${n}`,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        faviconDataUri: null,
      });
      return res({ tabId: `t${n}` });
    }
    const closed = path.match(/^\/browser\/tabs\/([^/]+)$/);
    if (closed && method === "DELETE") {
      const i = tabs.findIndex((t) => t.tabId === closed[1]);
      if (i >= 0) tabs.splice(i, 1);
      return res({ ok: true });
    }
    const nav = path.match(/^\/browser\/tabs\/([^/]+)\/navigate$/);
    if (nav && method === "POST") {
      const t = tabs.find((x) => x.tabId === nav[1]);
      if (t && body.action === "url") t.url = body.url;
      return res({ ok: true });
    }
    return res({ ok: true });
  });
  return { fetchMock, calls, tabs };
}

const paths = (calls, method) => calls.filter((c) => c.method === method).map((c) => c.path);

beforeEach(() => _resetBrowserPanel());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("browserPanelStore tabs", () => {
  it("openTab POSTs /browser/tabs and activates the new tab in ITS session only", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await openTab("B");
    expect(paths(calls, "POST")).toEqual(["/browser/tabs", "/browser/tabs"]);
    const a = getBrowserPanel("A");
    const b = getBrowserPanel("B");
    expect(a.activeTabId).toBe("t1");
    expect(b.activeTabId).toBe("t2");
    // Each session keeps its own active tab and URL bar (the mock daemon has no
    // session filtering, so both see the full list — the real one filters).
    expect(b.tabs.map((t) => t.tabId)).toEqual(["t1", "t2"]);
    expect(a.urlDraft).toBe("https://start.example/1");
    expect(b.urlDraft).toBe("https://start.example/2");
  });

  it("every daemon call declares its session (?session=), tab creation included", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await navigate("A", { action: "reload" });
    await setMuted("A", "t1", true);
    await setDevice("A", "mobile");
    await closeTab("A", "t1");
    expect(calls.length).toBeGreaterThan(4);
    expect(calls.every((c) => c.session === "A")).toBe(true);
    expect(withSession("/browser/tabs", "global")).toBe("/browser/tabs?session=global");
  });

  it("openTab forwards a start url and omits the field when absent", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A", "https://example.com/x");
    await openTab("A");
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/browser/tabs");
    expect(posts[0].body).toEqual({ url: "https://example.com/x" });
    expect(posts[1].body).toEqual({});
  });

  it("switchTab moves active within one pane, syncs the URL bar, and rejects an unknown tab", async () => {
    const { fetchMock } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await openTab("A");
    switchTab("A", "t1");
    expect(getBrowserPanel("A").activeTabId).toBe("t1");
    expect(getBrowserPanel("A").urlDraft).toBe("https://start.example/1");
    switchTab("A", "nope");
    expect(getBrowserPanel("A").activeTabId).toBe("t1");
  });

  it("closeTab DELETEs /browser/tabs/:id and re-picks a neighbour when the active one closes", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A"); await openTab("A"); await openTab("A");
    await closeTab("A", "t3"); // active (newest)
    expect(paths(calls, "DELETE")).toEqual(["/browser/tabs/t3"]);
    const s = getBrowserPanel("A");
    expect(s.tabs.map((t) => t.tabId)).toEqual(["t1", "t2"]);
    expect(s.activeTabId).toBe("t2");
  });

  it("closing an inactive tab leaves the active one alone", async () => {
    const { fetchMock } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A"); await openTab("A");
    await closeTab("A", "t1");
    expect(getBrowserPanel("A").activeTabId).toBe("t2");
  });

  it("closing the pane's LAST tab immediately opens a fresh one (never zero tabs)", async () => {
    const { fetchMock } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await closeTab("A", "t1");
    const s = getBrowserPanel("A");
    expect(s.tabs.map((t) => t.tabId)).toEqual(["t2"]);
    expect(s.activeTabId).toBe("t2");
  });

  it("refreshTabs keeps the draft the human is typing but follows a page-driven url change", async () => {
    const { fetchMock, tabs } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    setUrlDraft("A", "exam");
    await refreshTabs("A");
    expect(getBrowserPanel("A").urlDraft).toBe("exam");
    tabs[0].url = "https://moved.example/"; // the page navigated itself
    await refreshTabs("A");
    expect(getBrowserPanel("A").urlDraft).toBe("https://moved.example/");
  });

  it("notifies instead of throwing when the daemon refuses a tab open", async () => {
    const err = vi.spyOn(notify, "error").mockImplementation(() => 0);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "browser subsystem is disabled" }) })));
    expect(await openTab("A")).toBeNull();
    expect(err).toHaveBeenCalledWith("Browser tab open failed: browser subsystem is disabled");
  });
});

describe("browserPanelStore navigation", () => {
  it("submitting the URL bar POSTs a url navigate for the ACTIVE tab", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A"); await openTab("A");
    await navigate("A", { action: "url", url: "example.com/docs" });
    const nav = calls.find((c) => c.path.endsWith("/navigate"));
    expect(nav.path).toBe("/browser/tabs/t2/navigate");
    expect(nav.body).toEqual({ action: "url", url: "https://example.com/docs" });
    expect(getBrowserPanel("A").urlDraft).toBe("https://example.com/docs");
  });

  it("back / forward / reload dispatch their action with no url", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    for (const action of ["back", "forward", "reload"]) await navigate("A", { action });
    expect(calls.filter((c) => c.path === "/browser/tabs/t1/navigate").map((c) => c.body))
      .toEqual([{ action: "back" }, { action: "forward" }, { action: "reload" }]);
  });

  it("an empty address bar submits nothing", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await navigate("A", { action: "url", url: "   " });
    expect(calls.some((c) => c.path.endsWith("/navigate"))).toBe(false);
  });

  it("normalizeUrl accepts any address a real address bar does", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("  example.com/a b  ")).toBe("https://example.com/a b");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("localhost:3000")).toBe("https://localhost:3000"); // host:port, not a scheme
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(normalizeUrl("file:///tmp/x.html")).toBe("file:///tmp/x.html");
    expect(normalizeUrl("")).toBe("");
  });

  it("notifies when the daemon refuses a navigation", async () => {
    const err = vi.spyOn(notify, "error").mockImplementation(() => 0);
    patchBrowserPanel("A", { activeTabId: "t1" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: "origin not allowed" }) })));
    await navigate("A", { action: "url", url: "example.com" });
    expect(err).toHaveBeenCalledWith("Browser navigation failed: origin not allowed");
  });
});

describe("browserPanelStore SSE relay", () => {
  const TAB = (over) => ({ tabId: "t1", url: "https://one.example/", title: "One", loading: false, canGoBack: false, canGoForward: false, audible: false, muted: false, ...over });

  it("browser:tabs routes to the payload's OWNING session only, without a fetch", () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("the SSE relay must not refetch"); }));
    patchBrowserPanel("A", { activeTabId: "t1" });
    patchBrowserPanel("B", { activeTabId: "t2", tabs: [TAB({ tabId: "t2", url: "https://two.example/" })] });
    applyTabs({ sessionId: "A", tabs: [TAB(), TAB({ tabId: "t9", title: "Nine" })] });
    expect(getBrowserPanel("A")).toMatchObject({ activeTabId: "t1", urlDraft: "https://one.example/" });
    expect(getBrowserPanel("A").tabs.map((t) => t.title)).toEqual(["One", "Nine"]);
    // another session's entry is untouched by A's payload
    expect(getBrowserPanel("B").tabs.map((t) => t.tabId)).toEqual(["t2"]);
  });

  it("a payload without sessionId (wave-1 daemon) lands on the global session", () => {
    patchBrowserPanel("global", { activeTabId: "t1" });
    patchBrowserPanel("A", { tabs: [TAB({ tabId: "t2" })] });
    applyTabs({ tabs: [TAB({ title: "Shared" })] });
    expect(getBrowserPanel("global").tabs.map((t) => t.title)).toEqual(["Shared"]);
    expect(getBrowserPanel("A").tabs.map((t) => t.tabId)).toEqual(["t2"]);
  });

  it("a page navigating itself updates the title and the URL bar, mid-typing text survives", () => {
    patchBrowserPanel("A", { activeTabId: "t1" });
    applyTabs({ sessionId: "A", tabs: [TAB()] });
    setUrlDraft("A", "some.other.host");
    applyTabs({ sessionId: "A", tabs: [TAB({ title: "One (still)" })] }); // title changed, url did not
    expect(getBrowserPanel("A")).toMatchObject({ urlDraft: "some.other.host" });
    expect(getBrowserPanel("A").tabs[0].title).toBe("One (still)");
    applyTabs({ sessionId: "A", tabs: [TAB({ url: "https://one.example/deep", title: "Deep" })] }); // the page moved
    expect(getBrowserPanel("A").urlDraft).toBe("https://one.example/deep");
  });

  it("a closed tab relayed away re-picks the session's active tab, and subscribers fire once", () => {
    const cb = vi.fn();
    subscribe("A", cb);
    patchBrowserPanel("A", { activeTabId: "t2" });
    cb.mockClear();
    applyTabs({ sessionId: "A", tabs: [TAB()] });
    expect(getBrowserPanel("A").activeTabId).toBe("t1");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed browser:tabs payload", () => {
    patchBrowserPanel("A", { tabs: [TAB()] });
    applyTabs(undefined);
    applyTabs({ sessionId: "A" });
    expect(getBrowserPanel("A").tabs).toHaveLength(1);
  });

  it("browser:status records the engine state in every session, and only on a change", () => {
    const cb = vi.fn();
    subscribe("A", cb);
    patchBrowserPanel("A", {});
    patchBrowserPanel("B", {});
    cb.mockClear();
    applyStatus({ state: "crashed", chromePath: null, tabCount: 0 });
    expect(getBrowserPanel("A").engineState).toBe("crashed");
    expect(getBrowserPanel("B").engineState).toBe("crashed");
    expect(cb).toHaveBeenCalledTimes(1);
    applyStatus({ state: "crashed", chromePath: null, tabCount: 0 });
    expect(cb).toHaveBeenCalledTimes(1); // no re-emit for the same state
  });

  it("useLive relays all three browser reasons, and the panel no longer polls for tabs", () => {
    const useLive = readSrc("../hooks/useLive.js");
    expect(useLive).toContain('data.reason === "browser:tabs"');
    expect(useLive).toContain('data.reason === "browser:status"');
    expect(useLive).toContain('data.reason === "browser:activity"');
    const panel = readSrc("../views/browser/BrowserPanel.jsx");
    expect(panel).not.toMatch(/setInterval|startPolling/);
  });

  it("bindPaneSession aliases a pane id onto the session entry for the untouched chrome children", () => {
    const unbind = bindPaneSession("l1", "A");
    toggleMode("l1", "annotate"); // a chrome child keying by its pane id
    expect(getBrowserPanel("A").mode).toBe("annotate");
    expect(getBrowserPanel("l1").mode).toBe("annotate"); // reads resolve too
    unbind();
    expect(getBrowserPanel("l1").mode).toBe("view"); // unbound → its own (empty) entry
  });

  it("BrowserPanel reports its live pixel size on subscribe and on a debounced resize", () => {
    const panel = readSrc("../views/browser/BrowserPanel.jsx");
    // The daemon needs the panel's size to stream Responsive 1:1 and emulate the
    // viewport: subscribe carries it; a ResizeObserver re-reports it, debounced.
    expect(panel).toContain('type: "subscribe"');
    expect(panel).toContain('type: "resize"');
    expect(panel).toContain("ResizeObserver");
    expect(panel).toContain("devicePixelRatio");
    expect(panel).toContain("150"); // debounce interval, not a poll
    expect(panel).not.toMatch(/setInterval|startPolling/);
  });
});

describe("browserPanelStore blank tabs (empty state)", () => {
  it("isBlankUrl treats about:blank and empty as blank, real URLs as not", () => {
    expect(isBlankUrl("about:blank")).toBe(true);
    expect(isBlankUrl("")).toBe(true);
    expect(isBlankUrl(undefined)).toBe(true);
    expect(isBlankUrl("https://example.com/")).toBe(false);
  });

  it("a blank active tab leaves the address bar empty (its placeholder), not the literal about:blank", () => {
    const TAB = (url) => ({ tabId: "t1", url, title: "New tab", loading: false, canGoBack: false, canGoForward: false, audible: false, muted: false });
    patchBrowserPanel("A", { activeTabId: "t1" });
    applyTabs({ sessionId: "A", tabs: [TAB("about:blank")] });
    expect(getBrowserPanel("A").urlDraft).toBe("");
    // once it navigates to a real page the bar follows (empty state disappears)
    applyTabs({ sessionId: "A", tabs: [TAB("https://example.com/")] });
    expect(getBrowserPanel("A").urlDraft).toBe("https://example.com/");
  });

  it("BrowserPanel renders the empty state for a blank tab and the canvas only when not blank", () => {
    const panel = readSrc("../views/browser/BrowserPanel.jsx");
    expect(panel).toContain("BrowserEmptyState");
    expect(panel).toContain("isBlankUrl");
    expect(panel).toMatch(/!block && blank &&/);   // empty state shown when blank
    expect(panel).toMatch(/!block && !blank &&/);   // canvas mounted only when not blank
  });
});

describe("browserPanelStore audio", () => {
  it("mutes a tab through /browser/tabs/:id/mute with the boolean only", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await setMuted("A", "t1", true);
    expect(calls.find((c) => c.path.endsWith("/mute"))).toMatchObject({
      method: "POST", path: "/browser/tabs/t1/mute", body: { muted: true },
    });
  });

  it("unmutes the same way — the UI never touches the page's volume", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await setMuted("A", "t1", false);
    const bodies = calls.filter((c) => c.path.endsWith("/mute")).map((c) => c.body);
    expect(bodies).toEqual([{ muted: false }]);
    expect(JSON.stringify(bodies)).not.toContain("volume");
  });

  it("works on a tab the daemon has not heard yet (audible is best-effort)", async () => {
    const { fetchMock, calls, tabs } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    expect(tabs[0].audible).toBeUndefined(); // never reported audible
    await setMuted("A", "t1", true);
    expect(calls.some((c) => c.path === "/browser/tabs/t1/mute")).toBe(true);
  });

  it("notifies when the daemon refuses a mute", async () => {
    const err = vi.spyOn(notify, "error").mockImplementation(() => 0);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "unknown tab t9" }) })));
    await setMuted("A", "t9", true);
    expect(err).toHaveBeenCalledWith("Browser mute failed: unknown tab t9");
  });
});

describe("browserPanelStore modes", () => {
  it("the three modes are one mutually-exclusive enum, and the lit one toggles off", () => {
    expect(getBrowserPanel("A").mode).toBe("view");
    toggleMode("A", "annotate");
    expect(getBrowserPanel("A").mode).toBe("annotate");
    toggleMode("A", "pick");
    expect(getBrowserPanel("A").mode).toBe("pick"); // picking one clears the other
    toggleMode("A", "pick");
    expect(getBrowserPanel("A").mode).toBe("view");
  });

  it("mode is pane-scoped", () => {
    toggleMode("A", "annotate");
    expect(getBrowserPanel("B").mode).toBe("view");
  });

  // Regression: annotate (or pick) must not survive a close/reopen — resuming a
  // half-finished overlay against a not-yet-painted canvas is what left a white
  // band on reopen. Closing resets the transient mode so the fresh open mounts
  // the live canvas with no overlay.
  it("resetPanelView drops annotate/pick back to view, pane-scoped", () => {
    toggleMode("A", "annotate");
    toggleMode("B", "pick");
    resetPanelView("A");
    expect(getBrowserPanel("A").mode).toBe("view");
    expect(getBrowserPanel("B").mode).toBe("pick"); // another pane is untouched
    resetPanelView("B");
    expect(getBrowserPanel("B").mode).toBe("view");
  });

  it("BrowserPanel resets the mode when the panel closes (its connection-effect cleanup)", () => {
    const panel = readSrc("../views/browser/BrowserPanel.jsx");
    // The cleanup runs on unmount (panel close). It must reset the transient mode
    // alongside tearing down the socket, next to the connState reset.
    expect(panel).toContain("resetPanelView");
    expect(panel).toMatch(/resetPanelView\(sessionKey\)[\s\S]*connState: "closed"/);
  });
});

describe("browserPanelStore device", () => {
  it("selecting a device POSTs {device} to the active tab and mirrors it into the store", async () => {
    const { fetchMock, calls } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await setDevice("A", "mobile");
    const dev = calls.find((c) => c.path.endsWith("/device"));
    expect(dev).toMatchObject({ method: "POST", path: "/browser/tabs/t1/device", body: { device: "mobile" } });
    expect(getBrowserPanel("A")).toMatchObject({ device: "mobile", mode: "view", deviceBusy: false });
  });

  it("device is remembered per tab and follows the active tab; a fresh tab is Responsive", async () => {
    const { fetchMock } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A"); // t1
    await openTab("A"); // t2 (active)
    await setDevice("A", "mobile"); // emulates t2 only
    expect(getBrowserPanel("A").device).toBe("mobile");
    switchTab("A", "t1");
    expect(getBrowserPanel("A").device).toBe("responsive"); // t1 was never switched
    switchTab("A", "t2");
    expect(getBrowserPanel("A").device).toBe("mobile"); // follows the tab back
    await openTab("A"); // t3, brand new
    expect(getBrowserPanel("A").device).toBe("responsive");
  });

  it("a refused device switch keeps the selection at the actual device and notifies (no lie)", async () => {
    const err = vi.spyOn(notify, "error").mockImplementation(() => 0);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/device")) return { ok: false, status: 500, json: async () => ({ error: "emulation failed" }) };
      return { ok: true, status: 200, json: async () => ({ tabs: [] }) };
    }));
    patchBrowserPanel("A", { activeTabId: "t1" });
    await setDevice("A", "mobile");
    expect(getBrowserPanel("A")).toMatchObject({ device: "responsive", deviceBusy: false });
    expect(err).toHaveBeenCalledWith("Browser device failed: emulation failed");
  });

  it("device is pane-scoped", async () => {
    const { fetchMock } = mockDaemon();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await setDevice("A", "mobile");
    await openTab("B");
    expect(getBrowserPanel("B").device).toBe("responsive");
  });
});
