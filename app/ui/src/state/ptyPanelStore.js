// ptyPanelStore — tab list + active tab for the embedded
// multi-tab PTY terminal. A module singleton (like archiveStore) because the
// panel's toolbar toggle, the tab bar, and the panel body render across
// different subtrees and must share one source of truth; the singleton pattern
// also survives duplicate mounts (StrictMode / pane remounts).
//
// The tab-NUMBER counter is SERVER-owned: every tab mirrors the `number` the
// daemon assigned in its PtySession response. The store never invents numbers —
// it only reflects the server's session list.

import { api } from "../api/client.js";

let tabs = []; // [{ sessionId, number, exited }]
let activeId = null;
let snapshot = { tabs, activeId };
const subs = new Set();

function emit() {
  snapshot = { tabs, activeId };
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// Stable reference between emits — useSyncExternalStore contract.
export function getPtyPanel() {
  return snapshot;
}

// Open a new session: POST /pty → push the server-numbered tab → activate it.
// cols/rows seed the PTY; TerminalView re-fits and POSTs the real size on mount.
export async function openTab({ cols = 80, rows = 24, cwd } = {}) {
  const r = await api.createPty({ cols, rows, cwd });
  const s = r?.body;
  if (!r?.ok || !s?.sessionId) return null;
  tabs = [...tabs, { sessionId: s.sessionId, number: s.number, exited: false, fresh: true }];
  activeId = s.sessionId;
  emit();
  return s;
}

// Close a tab: DELETE /pty/:id, drop it. If it was the LAST tab, immediately
// open a fresh one so the panel never shows zero tabs (spec).
export async function closeTab(sessionId, { cwd } = {}) {
  await api.killPty(sessionId);
  const idx = tabs.findIndex((t) => t.sessionId === sessionId);
  const wasActive = activeId === sessionId;
  tabs = tabs.filter((t) => t.sessionId !== sessionId);
  if (tabs.length === 0) {
    activeId = null;
    emit();
    await openTab({ cwd });
    return;
  }
  if (wasActive) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activeId = next.sessionId;
  }
  emit();
}

export function switchTab(sessionId) {
  if (activeId === sessionId) return;
  if (!tabs.some((t) => t.sessionId === sessionId)) return;
  activeId = sessionId;
  emit();
}

// Reattach after a page reload / WKWebView relaunch: GET /pty → mirror the live
// server sessions as tabs. Scrollback replay is TerminalView's job (per-session
// GET /pty/:id/buffer on mount). Fail-soft: a daemon blip keeps the tabs we have.
export async function reattach() {
  let body;
  try {
    const r = await api.listPty();
    body = r?.ok ? r.body : null;
  } catch {
    return;
  }
  const sessions = body?.sessions;
  if (!Array.isArray(sessions)) return;
  tabs = sessions
    .slice()
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .map((s) => ({ sessionId: s.sessionId, number: s.number, exited: !s.alive, fresh: false }));
  if (!tabs.some((t) => t.sessionId === activeId)) {
    activeId = tabs[0]?.sessionId ?? null;
  }
  emit();
}

// First-mount marker cleared once TerminalView has skipped its buffer replay.
// After this a remount (panel close→reopen) treats the tab as a reattach and
// does replay, restoring scrollback.
export function clearFresh(sessionId) {
  const t = tabs.find((x) => x.sessionId === sessionId);
  if (!t || !t.fresh) return;
  tabs = tabs.map((x) => (x.sessionId === sessionId ? { ...x, fresh: false } : x));
  emit();
}

// pty:exit landed — mark the tab so the tab bar can show it died; the session
// stays until the user closes the tab.
export function markExited(sessionId) {
  const t = tabs.find((x) => x.sessionId === sessionId);
  if (!t || t.exited) return;
  tabs = tabs.map((x) => (x.sessionId === sessionId ? { ...x, exited: true } : x));
  emit();
}

// Test-only: reset the module singleton between cases.
export function _resetPtyPanel() {
  tabs = [];
  activeId = null;
  subs.clear();
  snapshot = { tabs, activeId };
}
