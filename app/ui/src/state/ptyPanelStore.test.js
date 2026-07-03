import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPtyPanel, openTab, closeTab, switchTab,
  killAllSessions, markExited, _resetPtyPanel,
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

beforeEach(() => _resetPtyPanel());
afterEach(() => vi.unstubAllGlobals());

describe("ptyPanelStore", () => {
  it("openTab pushes a server-numbered tab and activates it; switchTab moves active", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab();
    let s = getPtyPanel();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].number).toBe(1);
    expect(s.activeId).toBe(s.tabs[0].sessionId);

    await openTab();
    s = getPtyPanel();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[1].number).toBe(2);
    expect(s.activeId).toBe(s.tabs[1].sessionId); // newest tab is active

    const first = s.tabs[0].sessionId;
    switchTab(first);
    expect(getPtyPanel().activeId).toBe(first);
  });

  it("closeTab removes the tab and re-picks a neighbor when the active one closes", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab(); await openTab(); await openTab();
    const ids = getPtyPanel().tabs.map((t) => t.sessionId);
    await closeTab(ids[2]); // active (newest) closed
    const s = getPtyPanel();
    expect(s.tabs.map((t) => t.sessionId)).toEqual([ids[0], ids[1]]);
    expect(s.activeId).toBe(ids[1]);
  });

  it("closing the LAST remaining tab immediately opens a fresh one (never zero tabs)", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab();
    const only = getPtyPanel().tabs[0].sessionId;
    await closeTab(only);
    const s = getPtyPanel();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].sessionId).not.toBe(only); // a brand-new session
    expect(s.activeId).toBe(s.tabs[0].sessionId);
  });

  it("killAllSessions terminates every session and clears the tab list (panel close)", async () => {
    const fetchMock = mockServer();
    vi.stubGlobal("fetch", fetchMock);
    await openTab(); await openTab();
    expect(getPtyPanel().tabs).toHaveLength(2);

    await killAllSessions();
    expect(getPtyPanel().tabs).toEqual([]);
    expect(getPtyPanel().activeId).toBe(null);
    // Server-side too: no live sessions remain.
    const r = await fetchMock("http://127.0.0.1:7400/pty");
    expect(await r.json()).toEqual({ sessions: [] });
  });

  it("killAllSessions reaps stale server sessions the client never tracked (quit-while-open)", async () => {
    const fetchMock = mockServer();
    vi.stubGlobal("fetch", fetchMock);
    await openTab(); await openTab();  // server holds s1, s2
    _resetPtyPanel();                   // fresh mount: client store empty, server still holds them
    await killAllSessions();            // clean-open path reaps whatever the server lists
    const r = await fetchMock("http://127.0.0.1:7400/pty");
    expect(await r.json()).toEqual({ sessions: [] });
  });

  it("markExited flags the matching tab without removing it", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab();
    const id = getPtyPanel().tabs[0].sessionId;
    markExited(id);
    const s = getPtyPanel();
    expect(s.tabs[0].exited).toBe(true);
    expect(s.tabs).toHaveLength(1);
  });

  it("tab numbers come straight from the server response — no client-side counter", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab(); await openTab();
    expect(getPtyPanel().tabs.map((t) => t.number)).toEqual([1, 2]);
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
    await openTab({ cwd: "/proj/alpha" });
    await openTab();
    expect(bodies[0].cwd).toBe("/proj/alpha");
    expect("cwd" in bodies[1]).toBe(false); // undefined cwd is dropped from the payload
  });

  it("getPtyPanel returns a stable reference between emits (useSyncExternalStore contract)", () => {
    expect(getPtyPanel()).toBe(getPtyPanel());
  });
});
