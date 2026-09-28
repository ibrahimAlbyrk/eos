import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  adoptRemote, KINDS, getWorkspace, setCwd, openTerminal, splitPane, closePane,
  sessionExited, setTitle, setClaudeSession, reconcile, dropPaneOn, _resetCodeWorkspace,
  createGroup, switchGroup, switchGroupByIndex, cycleGroup, renameGroup, setGroupColor, deleteGroup,
  resumeSession,
} from "./codeWorkspaceStore.js";
import { getHistory, _resetCodeHistory } from "./codeHistoryStore.js";
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
      const claudeSessionId = body.claude ? body.claude.resume ?? crypto.randomUUID() : null;
      const s = { sessionId: `s${n}`, number: n, cwd: body.cwd, cols: 80, rows: 24, alive: true, claudeSessionId };
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
  _resetCodeHistory();
  server = mockServer();
  vi.stubGlobal("fetch", server.fetchMock);
  setCwd("/proj");
});
afterEach(() => vi.unstubAllGlobals());

describe("codeWorkspaceStore", () => {
  it("has the daemon start Claude Code, keeping its pinned conversation id, in the workspace folder", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const ws = getWorkspace();
    const term = ws.terms[ws.focusedId];
    expect(paneIds()).toHaveLength(1);
    expect(term).toMatchObject({ sessionId: "s1", kind: "claude", cwd: "/proj" });
    expect(term.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(server.creates[0]).toMatchObject({ cwd: "/proj", claude: {} });
  });

  it("a plain terminal sends no startup command", async () => {
    openTerminal(KINDS.shell);
    await flush();
    expect(server.creates[0].command).toBeUndefined();
    expect(server.creates[0].claude).toBeUndefined();
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

  it("reconcile resumes a dead Claude pane's conversation in place, in its folder", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const leafId = getWorkspace().focusedId;
    const { claudeSessionId } = getWorkspace().terms[leafId];
    server.sessions.clear();
    await reconcile();
    await flush();
    expect(server.creates[1]).toMatchObject({ cwd: "/proj", claude: { resume: claudeSessionId } });
    expect(getWorkspace().terms[leafId]).toMatchObject({ sessionId: "s2", kind: "claude", claudeSessionId });
  });

  it("the session hook's id replaces the pinned one, so a resume follows /clear", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const leafId = getWorkspace().focusedId;
    const next = "11111111-2222-4333-8444-555555555555";
    setClaudeSession(leafId, next);
    expect(getWorkspace().terms[leafId].claudeSessionId).toBe(next);
    const before = getWorkspace();
    setClaudeSession(leafId, next);
    expect(getWorkspace()).toBe(before);
    server.sessions.clear();
    await reconcile();
    await flush();
    expect(server.creates[1].claude).toEqual({ resume: next });
  });

  it("reconcile reopens a dead shell pane as a plain shell and keeps the layout", async () => {
    openTerminal(KINDS.claude);
    await flush();
    openTerminal(KINDS.shell);
    await flush();
    const before = paneIds();
    server.sessions.clear();
    await reconcile();
    await flush();
    expect(paneIds()).toEqual(before);
    expect(server.creates.slice(2).some((c) => c.claude === undefined)).toBe(true);
    expect(Object.keys(getWorkspace().terms)).toHaveLength(2);
  });

  it("reconcile leaves live panes alone", async () => {
    openTerminal(KINDS.claude);
    await flush();
    await reconcile();
    await flush();
    expect(server.creates).toHaveLength(1);
    expect(getWorkspace().terms[getWorkspace().focusedId].sessionId).toBe("s1");
  });

  it("reconcile drops a dead Claude pane with no pinned conversation id", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const leafId = getWorkspace().focusedId;
    delete getWorkspace().terms[leafId].claudeSessionId;
    server.sessions.clear();
    await reconcile();
    await flush();
    expect(getWorkspace().terms).toEqual({});
    expect(server.creates).toHaveLength(1);
  });

  it("the boot reap never kills workspace sessions", async () => {
    openTerminal(KINDS.claude);
    await flush();
    await reapUntrackedSessions();
    expect(server.sessions.has("s1")).toBe(true);
  });

  it("adopts a phone-opened session into its own group, leaving the screen as is", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const active = getWorkspace().activeGroupId;
    const phone = { sessionId: "p1", alive: true, remote: true, kind: "claude", cwd: "/work/eos", title: null, claudeSessionId: "c-1" };
    server.sessions.set("p1", phone);
    adoptRemote(phone);
    adoptRemote(phone); // a later metadata update adds nothing
    adoptRemote({ ...phone, sessionId: "local", remote: false });
    const ws = getWorkspace();
    expect(ws.activeGroupId).toBe(active);
    expect(ws.groups.map((g) => g.name)).toEqual(["Group 1", "Phone · eos"]);
    const leafId = leaves(ws.groups[1].tree)[0].id;
    expect(ws.terms[leafId]).toMatchObject({ sessionId: "p1", kind: "claude", claudeSessionId: "c-1" });
  });

  it("reconcile adopts phone sessions opened while the desktop was away, and the reap spares them", async () => {
    server.sessions.set("p1", { sessionId: "p1", alive: true, remote: true, kind: "shell", cwd: "/w", title: null, claudeSessionId: null });
    await reapUntrackedSessions();
    expect(server.sessions.has("p1")).toBe(true);
    await reconcile();
    expect(Object.values(getWorkspace().terms).map((t) => t.sessionId)).toEqual(["p1"]);
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

describe("codeWorkspaceStore history", () => {
  const closeClaude = async (title) => {
    openTerminal(KINDS.claude);
    await flush();
    const leafId = getWorkspace().focusedId;
    if (title) setTitle(leafId, title);
    const { claudeSessionId } = getWorkspace().terms[leafId];
    closePane(leafId);
    return claudeSessionId;
  };

  it("closing a pane keeps its session, with its folder, title and group color", async () => {
    const claudeSessionId = await closeClaude("✳ Fix PTY resize");
    const [e] = getHistory();
    expect(getHistory()).toHaveLength(1);
    expect(e).toMatchObject({
      id: claudeSessionId, kind: "claude", cwd: "/proj", title: "Fix PTY resize",
      claudeSessionId, color: getWorkspace().groups[0].color,
    });
    expect(e.startedAt).toBeLessThanOrEqual(e.closedAt);
  });

  it("resuming continues the conversation in its own folder and leaves the history", async () => {
    const claudeSessionId = await closeClaude("Fix PTY resize");
    setCwd("/elsewhere");
    await resumeSession(getHistory()[0]);
    expect(server.creates.at(-1)).toMatchObject({ cwd: "/proj", claude: { resume: claudeSessionId } });
    const ws = getWorkspace();
    expect(ws.terms[ws.focusedId]).toMatchObject({ kind: "claude", cwd: "/proj", title: "Fix PTY resize", claudeSessionId });
    expect(getHistory()).toEqual([]);
  });

  it("a resume beside a busy pane opens a split", async () => {
    await closeClaude();
    openTerminal(KINDS.shell);
    await flush();
    await resumeSession(getHistory()[0]);
    expect(paneIds()).toHaveLength(2);
    expect(getWorkspace().terms[getWorkspace().focusedId].kind).toBe("claude");
  });

  it("a failed resume keeps the entry to retry", async () => {
    await closeClaude();
    server.fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({ error: "no such folder" }) }));
    await resumeSession(getHistory()[0]);
    expect(getHistory()).toHaveLength(1);
    expect(getWorkspace().errors[getWorkspace().focusedId]).toBe("no such folder");
  });

  it("shells keep one entry per folder and reopen as a fresh shell there", async () => {
    for (let i = 0; i < 2; i += 1) {
      openTerminal(KINDS.shell);
      await flush();
      closePane(getWorkspace().focusedId);
    }
    expect(getHistory()).toEqual([expect.objectContaining({ id: "shell:/proj", kind: "shell" })]);
    await resumeSession(getHistory()[0]);
    expect(server.creates.at(-1)).toEqual({ cols: 120, rows: 32, cwd: "/proj" });
  });

  it("an exited shell and a deleted group's sessions are kept too", async () => {
    openTerminal(KINDS.shell);
    await flush();
    sessionExited("s1");
    const id = createGroup();
    openTerminal(KINDS.claude);
    await flush();
    deleteGroup(id);
    expect(getHistory().map((e) => e.kind)).toEqual(["claude", "shell"]);
  });

  it("a Claude pane with no conversation id is not kept", async () => {
    openTerminal(KINDS.claude);
    await flush();
    setClaudeSession(getWorkspace().focusedId, null);
    closePane(getWorkspace().focusedId);
    expect(getHistory()).toEqual([]);
  });
});

describe("codeWorkspaceStore groups", () => {
  const groupIds = () => getWorkspace().groups.map((g) => g.id);

  it("a new group comes on screen empty, and new panes open there", async () => {
    openTerminal(KINDS.claude);
    await flush();
    const first = getWorkspace().activeGroupId;
    const second = createGroup();
    expect(getWorkspace().activeGroupId).toBe(second);
    expect(paneIds()).toHaveLength(1);
    expect(getWorkspace().terms[getWorkspace().focusedId]).toBeUndefined();
    openTerminal(KINDS.shell);
    await flush();
    const g1 = getWorkspace().groups.find((g) => g.id === first);
    expect(leaves(g1.tree)).toHaveLength(1);
    expect(Object.keys(getWorkspace().terms)).toHaveLength(2);
  });

  it("new groups get distinct names and colors", () => {
    createGroup();
    createGroup();
    const { groups } = getWorkspace();
    expect(groups.map((g) => g.name)).toEqual(["Group 1", "Group 2", "Group 3"]);
    expect(new Set(groups.map((g) => g.color)).size).toBe(3);
  });

  it("switching restores each group's own layout and focus", async () => {
    openTerminal(KINDS.claude);
    await flush();
    openTerminal(KINDS.claude);
    await flush();
    const [first] = groupIds();
    const before = { tree: getWorkspace().tree, focusedId: getWorkspace().focusedId };
    createGroup();
    expect(paneIds()).toHaveLength(1);
    switchGroup(first);
    expect(getWorkspace().tree).toBe(before.tree);
    expect(getWorkspace().focusedId).toBe(before.focusedId);
  });

  it("⌃N and ⌃⇥ switch by position, wrapping around", () => {
    createGroup();
    createGroup();
    const ids = groupIds();
    switchGroupByIndex(0);
    expect(getWorkspace().activeGroupId).toBe(ids[0]);
    switchGroupByIndex(7);
    expect(getWorkspace().activeGroupId).toBe(ids[0]);
    cycleGroup(-1);
    expect(getWorkspace().activeGroupId).toBe(ids[2]);
    cycleGroup(1);
    expect(getWorkspace().activeGroupId).toBe(ids[0]);
  });

  it("a shell exiting in a background group closes its pane there", async () => {
    openTerminal(KINDS.claude);
    await flush();
    openTerminal(KINDS.shell);
    await flush();
    const [first] = groupIds();
    createGroup();
    sessionExited("s2");
    const g1 = getWorkspace().groups.find((g) => g.id === first);
    expect(leaves(g1.tree)).toHaveLength(1);
    expect(getWorkspace().terms[g1.focusedId].sessionId).toBe("s1");
    expect(paneIds()).toHaveLength(1);
  });

  it("deleting a group kills its sessions and shows a neighbour", async () => {
    const [first] = groupIds();
    const second = createGroup();
    openTerminal(KINDS.claude);
    await flush();
    deleteGroup(second);
    await flush();
    expect(server.sessions.size).toBe(0);
    expect(getWorkspace().terms).toEqual({});
    expect(groupIds()).toEqual([first]);
    expect(getWorkspace().activeGroupId).toBe(first);
  });

  it("deleting the last group leaves a fresh one", () => {
    const [only] = groupIds();
    deleteGroup(only);
    expect(groupIds()).toHaveLength(1);
    expect(groupIds()[0]).not.toBe(only);
  });

  it("rename trims and ignores blanks; color is stored by id", () => {
    const [id] = groupIds();
    renameGroup(id, "  Backend  ");
    renameGroup(id, "   ");
    setGroupColor(id, "violet");
    expect(getWorkspace().groups[0]).toMatchObject({ name: "Backend", color: "violet" });
    const before = getWorkspace();
    setGroupColor(id, "violet");
    expect(getWorkspace()).toBe(before);
  });
});

describe("codeWorkspaceStore persistence", () => {
  afterEach(() => vi.resetModules());

  it("a workspace saved before groups loads as the first group", async () => {
    const { leaf: mkLeaf } = await import("../lib/paneLayout.js");
    const tree = mkLeaf();
    const saved = { cwd: "/proj", tree, focusedId: tree.id, terms: { [tree.id]: { sessionId: "s9", kind: "shell", cwd: "/proj" } } };
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved), setItem: () => {} });
    vi.resetModules();
    const store = await import("./codeWorkspaceStore.js");
    const ws = store.getWorkspace();
    expect(ws.groups).toHaveLength(1);
    expect(ws.groups[0]).toMatchObject({ name: "Group 1", tree, focusedId: tree.id });
    expect(ws.tree).toEqual(tree);
    expect(ws.terms[tree.id].sessionId).toBe("s9");
  });
});

describe("codeHistoryStore persistence", () => {
  afterEach(() => vi.resetModules());

  it("the history survives a reload", async () => {
    const saved = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) });
    vi.resetModules();
    (await import("./codeHistoryStore.js")).recordClosed({ kind: "shell", cwd: "/proj", title: "zsh" }, "teal", 5);
    vi.resetModules();
    const { getHistory: reloaded } = await import("./codeHistoryStore.js");
    expect(reloaded()).toEqual([{
      id: "shell:/proj", kind: "shell", cwd: "/proj", title: "zsh", claudeSessionId: null, color: "teal", startedAt: null, closedAt: 5,
    }]);
  });
});
