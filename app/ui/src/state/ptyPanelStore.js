// ptyPanelStore — tab list + active tab for the embedded multi-tab PTY terminal,
// keyed by PANE id: each pane's terminal panel owns its own tabs/active state, so
// a split layout runs fully independent terminals. A module singleton (like
// archiveStore) because the panel's toolbar toggle, the tab bar, and the panel
// body render across different subtrees and must share one source of truth; the
// singleton pattern also survives duplicate mounts.
//
// Lifecycle: a pane's panel ALWAYS opens clean — there is no reattach/scrollback-
// replay path. Closing a pane's panel terminates ITS sessions (killPaneSessions);
// opening one reaps server sessions no pane tracks (reapUntrackedSessions), then
// spawns one fresh tab. The tab NUMBER is server-owned (mirrors the daemon's
// PtySession.number); the server counter resets when its registry empties.

import { api } from "../api/client.js";

const EMPTY = { tabs: [], activeId: null };
const panes = new Map(); // paneId -> { tabs, activeId, snapshot, subs }

function paneOf(paneId) {
  let p = panes.get(paneId);
  if (!p) {
    p = { tabs: [], activeId: null, snapshot: EMPTY, subs: new Set() };
    panes.set(paneId, p);
  }
  return p;
}

function emit(p) {
  p.snapshot = { tabs: p.tabs, activeId: p.activeId };
  for (const cb of p.subs) cb();
}

export function subscribe(paneId, cb) {
  const p = paneOf(paneId);
  p.subs.add(cb);
  return () => p.subs.delete(cb);
}

// Stable reference between emits — useSyncExternalStore contract.
export function getPtyPanel(paneId) {
  return panes.get(paneId)?.snapshot ?? EMPTY;
}

// Open a new session in a pane: POST /pty → push the server-numbered tab →
// activate it. cols/rows seed the PTY; TerminalView re-fits and POSTs the real
// size on mount.
export async function openTab(paneId, { cols = 80, rows = 24, cwd } = {}) {
  const r = await api.createPty({ cols, rows, cwd });
  const s = r?.body;
  if (!r?.ok || !s?.sessionId) return null;
  const p = paneOf(paneId);
  p.tabs = [...p.tabs, { sessionId: s.sessionId, number: s.number, exited: false }];
  p.activeId = s.sessionId;
  emit(p);
  return s;
}

// Close a tab: DELETE /pty/:id, drop it. If it was the pane's LAST tab,
// immediately open a fresh one so the panel never shows zero tabs (spec).
export async function closeTab(paneId, sessionId, { cwd } = {}) {
  const p = panes.get(paneId);
  if (!p) return;
  await api.killPty(sessionId);
  const idx = p.tabs.findIndex((t) => t.sessionId === sessionId);
  const wasActive = p.activeId === sessionId;
  p.tabs = p.tabs.filter((t) => t.sessionId !== sessionId);
  if (p.tabs.length === 0) {
    p.activeId = null;
    emit(p);
    await openTab(paneId, { cwd });
    return;
  }
  if (wasActive) {
    const next = p.tabs[Math.min(idx, p.tabs.length - 1)];
    p.activeId = next.sessionId;
  }
  emit(p);
}

export function switchTab(paneId, sessionId) {
  const p = panes.get(paneId);
  if (!p || p.activeId === sessionId) return;
  if (!p.tabs.some((t) => t.sessionId === sessionId)) return;
  p.activeId = sessionId;
  emit(p);
}

// Terminate ONE pane's sessions and clear its tab list — panel close, eviction,
// and viewer unmount. Never touches another pane's live sessions.
export async function killPaneSessions(paneId) {
  const p = panes.get(paneId);
  if (!p) return;
  const ids = p.tabs.map((t) => t.sessionId);
  p.tabs = [];
  p.activeId = null;
  emit(p);
  await Promise.all(ids.map((id) => api.killPty(id).catch(() => {})));
}

// Clean-open reap: DELETE server sessions NO pane tracks (e.g. left over from an
// app quit-while-open). Any pane's live tabs are never touched, so opening a
// terminal in one pane can't kill another pane's sessions.
export async function reapUntrackedSessions() {
  let server;
  try {
    const r = await api.listPty();
    server = r?.ok ? r.body?.sessions : null;
  } catch { return; } // daemon blip — nothing to reap
  if (!Array.isArray(server)) return;
  const tracked = new Set();
  for (const p of panes.values()) for (const t of p.tabs) tracked.add(t.sessionId);
  const stale = server.map((s) => s.sessionId).filter((id) => !tracked.has(id));
  await Promise.all(stale.map((id) => api.killPty(id).catch(() => {})));
}

// pty:exit landed — flag the owning pane's tab so its tab bar shows it died; the
// session stays until the user closes the tab. Session ids are server-unique, so
// the scan finds exactly one pane (keeps TerminalView pane-agnostic).
export function markExited(sessionId) {
  for (const p of panes.values()) {
    const t = p.tabs.find((x) => x.sessionId === sessionId);
    if (!t) continue;
    if (t.exited) return;
    p.tabs = p.tabs.map((x) => (x.sessionId === sessionId ? { ...x, exited: true } : x));
    emit(p);
    return;
  }
}

// Test-only: reset the module singleton between cases.
export function _resetPtyPanel() {
  panes.clear();
}
