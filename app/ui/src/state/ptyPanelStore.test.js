import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPtyPanel, openTab, closeTab, switchTab,
  reattach, markExited, clearFresh, _resetPtyPanel,
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

  it("reattach mirrors live server sessions as tabs sorted by number (page reload)", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab(); await openTab(); // server holds s1, s2
    _resetPtyPanel(); // client store wiped by reload; server keeps its sessions
    await reattach();
    const s = getPtyPanel();
    expect(s.tabs.map((t) => t.number)).toEqual([1, 2]);
    expect(s.activeId).toBe(s.tabs[0].sessionId);
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

  it("openTab marks the tab fresh (skips buffer replay); clearFresh flips it for remount replay", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab();
    const id = getPtyPanel().tabs[0].sessionId;
    expect(getPtyPanel().tabs[0].fresh).toBe(true);
    clearFresh(id);
    expect(getPtyPanel().tabs[0].fresh).toBe(false);
  });

  it("reattach-mirrored tabs are NOT fresh (they have server scrollback to replay)", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab();
    _resetPtyPanel();
    await reattach();
    expect(getPtyPanel().tabs.every((t) => t.fresh === false)).toBe(true);
  });

  it("tab numbers come straight from the server response — no client-side counter", async () => {
    vi.stubGlobal("fetch", mockServer());
    await openTab(); await openTab();
    expect(getPtyPanel().tabs.map((t) => t.number)).toEqual([1, 2]);
  });

  it("getPtyPanel returns a stable reference between emits (useSyncExternalStore contract)", () => {
    expect(getPtyPanel()).toBe(getPtyPanel());
  });
});
