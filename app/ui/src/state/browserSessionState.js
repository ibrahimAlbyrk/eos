// browserSessionState — per-SESSION browser panel memory + the unseen-activity
// badge and the auto-open/present rules (wave 2 items 2 + 4). Keyed by
// sessionKey (parent-chain root worker id, or "global"), module singleton in
// the browserPanelStore shape. panelOpen/activeTabId/everUsed persist to
// localStorage (cm:browserSessions) so the memory survives reloads;
// unseenCount and the everOpened latch are session-only by design.
//
// Pane-layout side effects (which pane shows a session, open a panel there)
// stay in React land: PaneProvider registers a small bridge here, so this
// store never imports pane state.

import { notify } from "../lib/notify.js";
import { GLOBAL_SESSION, sessionNameOf } from "../lib/agentIndex.js";
import { getBrowserPanel, patchBrowserPanel } from "./browserPanelStore.js";

const KEY = "cm:browserSessions";

const EMPTY = {
  panelOpen: false, // remembered open/closed (restored on session switch)
  activeTabId: null, // remembered shown tab
  everUsed: false, // first-browser-use latch (one auto-open per session)
  unseenCount: 0, // badge counter — not persisted
  everOpened: false, // panel opened at least once this visit — not persisted
};

let sessions = new Map(); // sessionKey -> { state, snapshot, subs }
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return;
    for (const [key, v] of Object.entries(raw)) {
      if (!v || typeof v !== "object") continue;
      const state = {
        ...EMPTY,
        panelOpen: v.panelOpen === true,
        activeTabId: typeof v.activeTabId === "string" ? v.activeTabId : null,
        everUsed: v.everUsed === true,
      };
      sessions.set(key, { state, snapshot: { ...state }, subs: new Set() });
    }
  } catch {
    // corrupt/absent storage — start clean
  }
}

function save() {
  try {
    const out = {};
    for (const [key, e] of sessions) {
      const { panelOpen, activeTabId, everUsed } = e.state;
      if (!panelOpen && !activeTabId && !everUsed) continue;
      out[key] = { panelOpen, activeTabId, everUsed };
    }
    globalThis.localStorage?.setItem(KEY, JSON.stringify(out));
  } catch {
    // storage disabled or over quota — memory is best-effort
  }
}

function entryOf(sessionKey) {
  hydrate();
  const key = sessionKey ?? GLOBAL_SESSION;
  let e = sessions.get(key);
  if (!e) {
    e = { state: { ...EMPTY }, snapshot: EMPTY, subs: new Set() };
    sessions.set(key, e);
  }
  return e;
}

function patch(sessionKey, partial) {
  const e = entryOf(sessionKey);
  e.state = { ...e.state, ...partial };
  e.snapshot = { ...e.state };
  for (const cb of e.subs) cb();
  save();
}

export function subscribe(sessionKey, cb) {
  const e = entryOf(sessionKey);
  e.subs.add(cb);
  return () => e.subs.delete(cb);
}

// Stable reference between patches — useSyncExternalStore contract.
export function getSessionState(sessionKey) {
  hydrate();
  return sessions.get(sessionKey ?? GLOBAL_SESSION)?.snapshot ?? EMPTY;
}

// ---- panel memory (item 2) --------------------------------------------------

// Session switch, BEFORE the pane's panels clear: capture whether the leaving
// session's browser panel was open and which tab it showed (from the
// session-keyed browserPanelStore entry, which outlives the panel).
export function stashBrowserSession(sessionKey, panelOpen) {
  patch(sessionKey, {
    panelOpen: panelOpen === true,
    activeTabId: getBrowserPanel(sessionKey).activeTabId ?? getSessionState(sessionKey).activeTabId,
  });
}

// Session switch, AFTER the clear: should the arriving session's browser panel
// come up? Either it was open when last seen, or it saw unseen activity before
// its one first-use auto-open ever happened (the deferred auto-open).
export function shouldRestoreBrowser(sessionKey) {
  const s = getSessionState(sessionKey);
  return s.panelOpen || (s.everUsed && s.unseenCount > 0 && !s.everOpened);
}

// BrowserPanel mount (every open path: toggle, restore, auto-open, present):
// the human is looking now — badge clears, latches set.
export function notePanelOpened(sessionKey) {
  patch(sessionKey, { panelOpen: true, everOpened: true, unseenCount: 0 });
}

// BrowserPanel mount: re-apply the remembered tab when the live store entry has
// none (fresh module after a reload). The next tab-list fetch keeps it if the
// tab still exists and falls back to the first tab if not.
export function seedRememberedTab(sessionKey) {
  const remembered = getSessionState(sessionKey).activeTabId;
  if (remembered && !getBrowserPanel(sessionKey).activeTabId) {
    patchBrowserPanel(sessionKey, { activeTabId: remembered });
  }
}

// ---- activity rules (item 4) ------------------------------------------------

// Pane-layout bridge, registered by PaneProvider:
//   panesShowing(sessionKey) -> paneIds whose shown agent belongs to the session
//   isBrowserOpenIn(paneId)  -> that pane's browser panel is open
//   openBrowserIn(paneId, sessionKey) -> open the browser panel in that pane
let bridge = null;
export function registerBrowserSessionUi(b) {
  bridge = b;
}

// SSE browser:activity — an agent used (tab opened / page loaded) or presented
// (browser_show) its session's browser. Missing sessionId = wave-1 daemon =
// the global session.
export function applyActivity(payload) {
  const kind = payload?.kind;
  if (kind !== "use" && kind !== "present") return;
  const sessionKey = payload.sessionId ?? GLOBAL_SESSION;
  const tabId = typeof payload.tabId === "string" ? payload.tabId : null;
  const panes = bridge?.panesShowing(sessionKey) ?? [];

  if (kind === "present") {
    // Present always selects the tab and brings the panel up where the session
    // is visible; when it isn't, a CLICKABLE toast that jumps to the session and
    // opens its browser on the presented tab, plus the badge as a backstop, and
    // panelOpen is latched so switching to the session opens it either way.
    if (tabId) patchBrowserPanel(sessionKey, { activeTabId: tabId });
    if (panes.length > 0) {
      patch(sessionKey, { everUsed: true, panelOpen: true, activeTabId: tabId ?? getSessionState(sessionKey).activeTabId });
      bridge.openBrowserIn(panes[0], sessionKey);
    } else {
      const s = getSessionState(sessionKey);
      patch(sessionKey, {
        everUsed: true,
        panelOpen: true,
        activeTabId: tabId ?? s.activeTabId,
        unseenCount: s.unseenCount + 1,
      });
      // Prefer the session's human-readable name (agentIndex, fed by the worker
      // snapshots); fall back to the URL, then a generic phrase, when the name
      // isn't known here. The click selects the session + opens the panel on the tab.
      const name = sessionNameOf(sessionKey);
      const where = name ? ` in ${name}` : payload.url ? ` (${payload.url})` : "";
      notify.info(`Agent is presenting a page${where} — click to view.`, {
        action: { label: "View", onClick: () => bridge?.openSessionBrowser?.(sessionKey) },
      });
    }
    return;
  }

  // kind === "use"
  const s = getSessionState(sessionKey);
  if (panes.length > 0 && !s.everUsed) {
    // First browser use while the session is on screen: auto-open once.
    patch(sessionKey, { everUsed: true, panelOpen: true });
    bridge.openBrowserIn(panes[0], sessionKey);
    return;
  }
  // Later use (or session not on screen): badge only — unless the session's
  // panel is already open in a visible pane (the human is watching).
  const watching = panes.some((p) => bridge?.isBrowserOpenIn(p));
  patch(sessionKey, { everUsed: true, ...(watching ? {} : { unseenCount: s.unseenCount + 1 }) });
}

// Test-only: reset the module singleton between cases.
export function _resetBrowserSessions() {
  sessions = new Map();
  hydrated = false;
  bridge = null;
}
