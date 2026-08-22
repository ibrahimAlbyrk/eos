import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { notify } from "../lib/notify.js";
import { patchBrowserPanel, getBrowserPanel, _resetBrowserPanel } from "./browserPanelStore.js";
import {
  subscribe, getSessionState, stashBrowserSession, shouldRestoreBrowser,
  notePanelOpened, seedRememberedTab, registerBrowserSessionUi, applyActivity,
  _resetBrowserSessions,
} from "./browserSessionState.js";
import { updateAgentNames, _resetAgentIndex } from "../lib/agentIndex.js";

function stubStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
}

beforeEach(() => {
  _resetBrowserSessions();
  _resetBrowserPanel();
  _resetAgentIndex();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
  vi.restoreAllMocks();
});

// A pane-layout bridge stub: `showing` maps sessionKey -> paneIds, `open` is the
// set of paneIds whose browser panel is open, `opened` records auto-opens, and
// `presented` records the sessions the clickable present-toast jumped to.
function bridge({ showing = {}, open = new Set() } = {}) {
  const opened = [];
  const presented = [];
  registerBrowserSessionUi({
    panesShowing: (key) => showing[key] ?? [],
    isBrowserOpenIn: (paneId) => open.has(paneId),
    openBrowserIn: (paneId, key) => { opened.push([paneId, key]); open.add(paneId); },
    openSessionBrowser: (key) => { presented.push(key); },
  });
  return { opened, open, presented };
}

describe("browserSessionState panel memory (session switch)", () => {
  it("panel state survives an A→B→A switch, including a B that never used the browser", () => {
    // On session A: panel open, looking at t2.
    patchBrowserPanel("A", { activeTabId: "t2" });
    // Switch A→B: stash A as open, arrive at B — nothing to restore there.
    stashBrowserSession("A", true);
    expect(shouldRestoreBrowser("B")).toBe(false);
    // Switch B→A: B stashes closed; A restores open on the remembered tab.
    stashBrowserSession("B", false);
    expect(shouldRestoreBrowser("A")).toBe(true);
    expect(getSessionState("A").activeTabId).toBe("t2");
    expect(shouldRestoreBrowser("B")).toBe(false); // B stays closed
  });

  it("a panel closed before the switch does not restore", () => {
    patchBrowserPanel("A", { activeTabId: "t1" });
    stashBrowserSession("A", false);
    expect(shouldRestoreBrowser("A")).toBe(false);
  });

  it("seedRememberedTab re-applies the remembered tab only when the live store has none", () => {
    stashBrowserSession("A", true); // browserPanelStore empty → keeps prior memory (null)
    patchBrowserPanel("A", { activeTabId: "t3" });
    stashBrowserSession("A", true);
    _resetBrowserPanel(); // reload: panel store is fresh, memory survives
    seedRememberedTab("A");
    expect(getBrowserPanel("A").activeTabId).toBe("t3");
    patchBrowserPanel("A", { activeTabId: "t5" });
    seedRememberedTab("A"); // live store already has a tab → untouched
    expect(getBrowserPanel("A").activeTabId).toBe("t5");
  });
});

describe("browserSessionState activity rules", () => {
  it("first use while the session is visible auto-opens exactly once", () => {
    const { opened, open } = bridge({ showing: { A: ["p1"] } });
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    expect(opened).toEqual([["p1", "A"]]);
    expect(getSessionState("A")).toMatchObject({ everUsed: true, unseenCount: 0 });
    // Later use with the panel open: no re-open, no badge.
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    expect(opened).toHaveLength(1);
    expect(getSessionState("A").unseenCount).toBe(0);
    // Panel closed again: use badges instead of re-opening.
    open.delete("p1");
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    expect(opened).toHaveLength(1);
    expect(getSessionState("A").unseenCount).toBe(1);
  });

  it("use bumps unseen only when the session is not visible (or its panel is closed)", () => {
    bridge({ showing: { A: ["p1"] }, open: new Set(["p1"]) });
    notePanelOpened("A"); // human already watching A's open panel
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    expect(getSessionState("A").unseenCount).toBe(0); // visible + open → skip
    applyActivity({ sessionId: "B", kind: "use", tabId: "t2" });
    applyActivity({ sessionId: "B", kind: "use", tabId: "t2" });
    expect(getSessionState("B")).toMatchObject({ everUsed: true, unseenCount: 2 });
  });

  it("an unseen use latches the deferred first-use auto-open for the next switch", () => {
    bridge({ showing: {} });
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    expect(getSessionState("A")).toMatchObject({ everUsed: true, unseenCount: 1, panelOpen: false });
    expect(shouldRestoreBrowser("A")).toBe(true); // opens on arrival despite panelOpen=false
    // The human saw it, closed it, and switched away — a later use badges but
    // never earns a second auto-open this visit.
    notePanelOpened("A");
    stashBrowserSession("A", false);
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    expect(getSessionState("A").unseenCount).toBe(1);
    expect(shouldRestoreBrowser("A")).toBe(false);
  });

  it("present opens a previously-closed panel in the pane showing the session and selects the tab", () => {
    const { opened } = bridge({ showing: { A: ["p1"] } });
    applyActivity({ sessionId: "A", kind: "present", tabId: "t9" });
    expect(opened).toEqual([["p1", "A"]]);
    expect(getBrowserPanel("A").activeTabId).toBe("t9");
    expect(getSessionState("A")).toMatchObject({ panelOpen: true, everUsed: true, activeTabId: "t9" });
  });

  it("present with no visible pane raises a clickable toast whose action jumps to the session's browser, keeps the badge, and latches open-on-switch", () => {
    const info = vi.spyOn(notify, "info").mockImplementation(() => 0);
    const { presented } = bridge({ showing: {} });
    applyActivity({ sessionId: "A", kind: "present", tabId: "t9", url: "https://x.example/" });
    expect(info).toHaveBeenCalledTimes(1);
    // The toast carries a click action (not a plain notice) that opens the
    // session's browser on the presented tab.
    const [, opts] = info.mock.calls[0];
    expect(opts.action).toMatchObject({ label: expect.any(String) });
    opts.action.onClick();
    expect(presented).toEqual(["A"]);
    // Badge stays as a backstop for a human who ignores the toast; the presented
    // tab is remembered and the panel latches open for a later session switch.
    expect(getSessionState("A")).toMatchObject({ unseenCount: 1, panelOpen: true, activeTabId: "t9" });
    expect(shouldRestoreBrowser("A")).toBe(true);
  });

  it("the present-fallback toast names the session when agentIndex knows it", () => {
    const info = vi.spyOn(notify, "info").mockImplementation(() => 0);
    bridge({ showing: {} });
    updateAgentNames([{ id: "A", parent_id: null, name: "Login flow", is_orchestrator: true }]);
    applyActivity({ sessionId: "A", kind: "present", tabId: "t9", url: "https://x.example/" });
    expect(info.mock.calls[0][0]).toBe("Agent is presenting a page in Login flow — click to view.");
  });

  it("the present-fallback toast falls back to the URL when the session name is unknown", () => {
    const info = vi.spyOn(notify, "info").mockImplementation(() => 0);
    bridge({ showing: {} });
    applyActivity({ sessionId: "A", kind: "present", tabId: "t9", url: "https://x.example/" });
    expect(info.mock.calls[0][0]).toBe("Agent is presenting a page (https://x.example/) — click to view.");
  });

  it("missing sessionId (wave-1 daemon) routes activity to the global session; junk is ignored", () => {
    bridge({ showing: {} });
    applyActivity({ kind: "use", tabId: "t1" });
    expect(getSessionState("global").unseenCount).toBe(1);
    applyActivity({ kind: "reload" });
    applyActivity(undefined);
    expect(getSessionState("global").unseenCount).toBe(1);
  });

  it("the badge clears when the panel opens, and subscribers hear it", () => {
    bridge({ showing: {} });
    const cb = vi.fn();
    subscribe("A", cb);
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    expect(getSessionState("A").unseenCount).toBe(2);
    cb.mockClear();
    notePanelOpened("A");
    expect(getSessionState("A")).toMatchObject({ unseenCount: 0, panelOpen: true, everOpened: true });
    expect(cb).toHaveBeenCalled();
  });
});

describe("browserSessionState persistence", () => {
  it("panelOpen/activeTabId/everUsed survive a reload; unseenCount and everOpened do not", () => {
    bridge({ showing: {} });
    patchBrowserPanel("A", { activeTabId: "t4" });
    stashBrowserSession("A", true);
    applyActivity({ sessionId: "A", kind: "use", tabId: "t4" });
    notePanelOpened("A");
    applyActivity({ sessionId: "A", kind: "use", tabId: "t4" });
    expect(getSessionState("A")).toMatchObject({ unseenCount: 1, everOpened: true });
    _resetBrowserSessions(); // reload — the stubbed localStorage survives
    expect(getSessionState("A")).toMatchObject({
      panelOpen: true, activeTabId: "t4", everUsed: true, unseenCount: 0, everOpened: false,
    });
  });

  it("works without localStorage (memory only)", () => {
    delete globalThis.localStorage;
    bridge({ showing: {} });
    applyActivity({ sessionId: "A", kind: "use", tabId: "t1" });
    expect(getSessionState("A").unseenCount).toBe(1);
  });
});
