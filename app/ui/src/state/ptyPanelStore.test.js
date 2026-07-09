import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  subscribe, getPtyPanel, openTab, closeTab, switchTab,
  killPaneSessions, reapUntrackedSessions, markExited, _resetPtyPanel,
} from "./ptyPanelStore.js";

// A tiny in-memory PTY daemon: POST /pty mints a server-numbered session, DELETE
// kills one, GET /pty lists the live set. Mirrors the shared PtySession contract
// so the store's server-owned-number assumption is exercised for real.
function mockServer() {
  const sessions = new Map();
  let n = 0;
  const res = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  return vi.fn(async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const path = new URL(url).pathname;
    if (path === "/pty" && method === "POST") {
      n += 1;
      const s = { sessionId: `s${n}`, number: n, cwd: "/tmp", cols: 80, rows: 24, alive: true };
      sessions.set(s.sessionId, s);
      return res(s);
    }
    if (path === "/pty" && method === "GET") return res({ sessions: [...sessions.values()] });
    const m = path.match(/^\/pty\/([^/]+)$/);
    if (m && method === "DELETE") { sessions.delete(m[1]); return res({ ok: true }); }
    return res({ ok: true });
  });
}

const serverIds = async (fetchMock) => {
  const r = await fetchMock("http://127.0.0.1:7400/pty");
  return (await r.json()).sessions.map((s) => s.sessionId);
};

beforeEach(() => _resetPtyPanel());
afterEach(() => vi.unstubAllGlobals());

describe("ptyPanelStore (pane-keyed)", () => {
  it("openTab pushes a server-numbered tab and activates it in ITS pane only", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab("A");
    await openTab("B");
    const a = getPtyPanel("A");
    const b = getPtyPanel("B");
    expect(a.tabs).toHaveLength(1);
    expect(b.tabs).toHaveLength(1);
    expect(a.tabs[0].sessionId).not.toBe(b.tabs[0].sessionId);
    expect(a.activeId).toBe(a.tabs[0].sessionId);
    expect(b.activeId).toBe(b.tabs[0].sessionId);
  });

  it("switchTab moves active within one pane and rejects another pane's session", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab("A"); await openTab("A");
    await openTab("B");
    const first = getPtyPanel("A").tabs[0].sessionId;
    switchTab("A", first);
    expect(getPtyPanel("A").activeId).toBe(first);
    // B's session id is unknown to pane A — no cross-pane switching.
    switchTab("A", getPtyPanel("B").tabs[0].sessionId);
    expect(getPtyPanel("A").activeId).toBe(first);
  });

  it("subscribe is pane-scoped: pane A's mutations never notify pane B", async () => {
    vi.stubGlobal("fetch", mockServer());
    const aCalls = vi.fn();
    const bCalls = vi.fn();
    subscribe("A", aCalls);
    subscribe("B", bCalls);
    await openTab("A");
    expect(aCalls).toHaveBeenCalled();
    expect(bCalls).not.toHaveBeenCalled();
  });

  it("closeTab removes the tab and re-picks a neighbor when the active one closes", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab("A"); await openTab("A"); await openTab("A");
    const ids = getPtyPanel("A").tabs.map((t) => t.sessionId);
    await closeTab("A", ids[2]); // active (newest) closed
    const s = getPtyPanel("A");
    expect(s.tabs.map((t) => t.sessionId)).toEqual([ids[0], ids[1]]);
    expect(s.activeId).toBe(ids[1]);
  });

  it("closing the pane's LAST tab immediately opens a fresh one (never zero tabs)", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab("A");
    const only = getPtyPanel("A").tabs[0].sessionId;
    await closeTab("A", only);
    const s = getPtyPanel("A");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].sessionId).not.toBe(only); // a brand-new session
    expect(s.activeId).toBe(s.tabs[0].sessionId);
  });

  it("closing a tab in pane A leaves pane B untouched", async () => {
    const fetchMock = mockServer();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A"); await openTab("A");
    await openTab("B");
    const bId = getPtyPanel("B").tabs[0].sessionId;
    await closeTab("A", getPtyPanel("A").tabs[0].sessionId);
    expect(getPtyPanel("B").tabs.map((t) => t.sessionId)).toEqual([bId]);
    expect(await serverIds(fetchMock)).toContain(bId);
  });

  it("killPaneSessions terminates ONLY that pane's sessions (panel close)", async () => {
    const fetchMock = mockServer();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A"); await openTab("A");
    await openTab("B");
    const bId = getPtyPanel("B").tabs[0].sessionId;

    await killPaneSessions("A");
    expect(getPtyPanel("A").tabs).toEqual([]);
    expect(getPtyPanel("A").activeId).toBe(null);
    expect(getPtyPanel("B").tabs).toHaveLength(1);
    expect(await serverIds(fetchMock)).toEqual([bId]); // B's session survives server-side
  });

  it("reapUntrackedSessions kills stale server sessions and leaves every pane's tracked ones alone", async () => {
    const fetchMock = mockServer();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A");
    await openTab("B");
    const tracked = [getPtyPanel("A").tabs[0].sessionId, getPtyPanel("B").tabs[0].sessionId];
    // A stale server session no pane tracks (e.g. app quit while open).
    await fetchMock("http://127.0.0.1:7400/pty", { method: "POST", body: "{}" });

    await reapUntrackedSessions();
    expect((await serverIds(fetchMock)).sort()).toEqual(tracked.sort());
    expect(getPtyPanel("A").tabs).toHaveLength(1);
    expect(getPtyPanel("B").tabs).toHaveLength(1);
  });

  it("reapUntrackedSessions reaps everything when no pane tracks anything (quit-while-open)", async () => {
    const fetchMock = mockServer();
    vi.stubGlobal("fetch", fetchMock);
    await openTab("A"); await openTab("A"); // server holds s1, s2
    _resetPtyPanel();                        // fresh mount: store empty, server still holds them
    await reapUntrackedSessions();
    expect(await serverIds(fetchMock)).toEqual([]);
  });

  it("markExited flags the matching tab in its owning pane without removing it", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab("A");
    await openTab("B");
    const id = getPtyPanel("B").tabs[0].sessionId;
    markExited(id);
    expect(getPtyPanel("B").tabs[0].exited).toBe(true);
    expect(getPtyPanel("B").tabs).toHaveLength(1);
    expect(getPtyPanel("A").tabs[0].exited).toBe(false);
  });

  it("tab numbers are derived from the pane's live list, not the server counter", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab("A"); await openTab("A"); await openTab("A");
    expect(getPtyPanel("A").tabs.map((t) => t.number)).toEqual([1, 2, 3]);
  });

  it("tab number restarts at 1 when the pane empties, even as the server counter climbs", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab("A"); await openTab("A"); await openTab("A"); // [1,2,3]
    // Close every tab; closing the last auto-opens a fresh one (never zero tabs).
    for (const id of getPtyPanel("A").tabs.map((t) => t.sessionId)) {
      await closeTab("A", id);
    }
    // Server minted s4/number 4 for the reopen, but the label restarts at 1.
    expect(getPtyPanel("A").tabs.map((t) => t.number)).toEqual([1]);
  });

  it("a new tab fills the lowest free number gap", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab("A"); await openTab("A"); await openTab("A"); // [1,2,3]
    const mid = getPtyPanel("A").tabs[1].sessionId; // number 2
    await closeTab("A", mid); // [1,3]
    await openTab("A"); // fills the gap → 2
    expect(getPtyPanel("A").tabs.map((t) => t.number).sort()).toEqual([1, 2, 3]);
  });

  it("openTab forwards cwd to POST /pty when given, and omits it when absent", async () => {
    const bodies = [];
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (url, opts = {}) => {
      const path = new URL(url).pathname;
      if (path === "/pty" && (opts.method ?? "GET") === "POST") {
        bodies.push(JSON.parse(opts.body));
        n += 1;
        return { ok: true, status: 200, json: async () => ({ sessionId: `s${n}`, number: n, alive: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }));
    await openTab("A", { cwd: "/proj/alpha" });
    await openTab("A");
    expect(bodies[0].cwd).toBe("/proj/alpha");
    expect("cwd" in bodies[1]).toBe(false); // undefined cwd is dropped from the payload
  });

  it("getPtyPanel returns a stable reference between emits (useSyncExternalStore contract)", () => {
    expect(getPtyPanel("A")).toBe(getPtyPanel("A"));
    expect(getPtyPanel("never-opened")).toBe(getPtyPanel("never-opened"));
  });
});
