import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CLAUDE_COMMAND, KINDS, getWorkspace, setCwd, openTerminal, splitPane, closePane,
  sessionExited, setTitle, reconcile, dropPaneOn, _resetCodeWorkspace,
} from "./codeWorkspaceStore.js";
import { reapUntrackedSessions } from "./ptyPanelStore.js";
import { leaves } from "../lib/paneLayout.js";

// In-memory PTY daemon: POST /pty mints a session (recording its body), GET
// lists the live set, DELETE kills one.
function mockServer() {
  const sessions = new Map();
  const creates = [];
  let n = 0;
  const res = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
  const fetchMock = vi.fn(async (url, opts = {}) => {
    const method = opts.method ?? "GET";
    const path = new URL(url).pathname;
    if (path === "/pty" && method === "POST") {
      n += 1;
      const body = JSON.parse(opts.body);
      creates.push(body);
      const s = { sessionId: `s${n}`, number: n, cwd: body.cwd, cols: 80, rows: 24, alive: true };
      sessions.set(s.sessionId, s);
      return res(s);
    }
    if (path === "/pty" && method === "GET") return res({ sessions: [...sessions.values()] });
    const m = path.match(/^\/pty\/([^/]+)$/);
    if (m && method === "DELETE") { sessions.delete(m[1]); return res({ ok: true }); }
    return res({ ok: true });
  });
  return { fetchMock, sessions, creates };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const paneIds = () => leaves(getWorkspace().tree).map((l) => l.id);

let server;
beforeEach(() => {
  _resetCodeWorkspace();
  server = mockServer();
  vi.stubGlobal("fetch", server.fetchMock);
  setCwd("/proj");
});
afterEach(() => vi.unstubAllGlobals());

describe("codeWorkspaceStore", () => {
  it("starts Claude Code (the cc expansion) in the empty focused pane, in the workspace folder", async () => {
    openTerminal(KINDS.claude);
    await flush();
    expect(server.creates[0]).toMatchObject({ cwd: "/proj", command: CLAUDE_COMMAND });
    const ws = getWorkspace();
    expect(paneIds()).toHaveLength(1);
    expect(ws.terms[ws.focusedId]).toMatchObject({ sessionId: "s1", kind: "claude", cwd: "/proj" });
  });

  it("a plain terminal sends no startup command", async () => {
    openTerminal(KINDS.shell);
    await flush();
    expect(server.creates[0].command).toBeUndefined();
  });

  it("a busy focused pane is split, and the new pane takes focus", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const first = getWorkspace().focusedId;
    openTerminal(KINDS.claude);
    await flush();
    expect(paneIds()).toHaveLength(2);
    expect(getWorkspace().focusedId).not.toBe(first);
    expect(Object.keys(getWorkspace().terms)).toHaveLength(2);
  });

  it("a split inherits the source pane's folder", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const src = getWorkspace().focusedId;
    setCwd("/elsewhere");
    splitPane(src, "col", KINDS.shell);
    await flush();
    expect(server.creates[1]).toMatchObject({ cwd: "/proj" });
    expect(getWorkspace().tree.dir).toBe("col");
  });

  it("closing kills the session; the last pane empties back to the launcher", async () => {
    openTerminal(KINDS.claude);
    await flush();
    closePane(getWorkspace().focusedId);
    await flush();
    expect(server.sessions.size).toBe(0);
    expect(paneIds()).toHaveLength(1);
    expect(getWorkspace().terms).toEqual({});
  });

  it("a shell exit closes its pane and focuses a survivor", async () => {
    openTerminal(KINDS.claude);
    await flush();
    openTerminal(KINDS.claude);
    await flush();
    sessionExited("s2");
    const ws = getWorkspace();
    expect(paneIds()).toEqual([ws.focusedId]);
    expect(ws.terms[ws.focusedId].sessionId).toBe("s1");
  });

  it("reconcile drops panes whose session died daemon-side", async () => {
    openTerminal(KINDS.claude);
    await flush();
    server.sessions.clear();
    await reconcile();
    expect(getWorkspace().terms).toEqual({});
  });

  it("the boot reap never kills workspace sessions", async () => {
    openTerminal(KINDS.claude);
    await flush();
    await reapUntrackedSessions();
    expect(server.sessions.has("s1")).toBe(true);
  });

  it("titles drop leading status glyphs and only change on a real change", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const id = getWorkspace().focusedId;
    setTitle(id, "✳ Fix the login bug");
    const before = getWorkspace();
    setTitle(id, "⠂ Fix the login bug");
    expect(getWorkspace()).toBe(before);
    expect(getWorkspace().terms[id].title).toBe("Fix the login bug");
  });

  it("dropping a pane on another's center swaps them", async () => {
    openTerminal(KINDS.claude);
    await flush();
    openTerminal(KINDS.claude);
    await flush();
    const [a, b] = paneIds();
    dropPaneOn(a, { kind: "replace" }, b);
    expect(paneIds()).toEqual([b, a]);
  });
});
