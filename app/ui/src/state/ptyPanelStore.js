// ptyPanelStore — tab list + active tab for the embedded multi-tab PTY terminal.
// A module singleton (like archiveStore) because the panel's toolbar toggle, the
// tab bar, and the panel body render across different subtrees and must share one
// source of truth; the singleton pattern also survives duplicate mounts.
//
// Lifecycle: the panel ALWAYS opens clean — there is no reattach/scrollback-replay
// path. Closing the panel terminates every session (killAllSessions); opening it
// kills any stale server sessions, then spawns one fresh tab. The tab NUMBER is
// server-owned (mirrors the daemon's PtySession.number); the server counter
// resets when its registry empties, so a clean open yields the single "Terminal".

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
  tabs = [...tabs, { sessionId: s.sessionId, number: s.number, exited: false }];
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

// Terminate every session and clear the tab list. Used on panel close AND at the
// start of a clean open (never reattach/replay a stale session). Clears the UI
// first (no flash of old tabs), then reconciles with the server's live list and
// DELETEs all — so sessions left over from an app quit-while-open are reaped too.
export async function killAllSessions() {
  const known = tabs.map((t) => t.sessionId);
  tabs = [];
  activeId = null;
  emit();
  let ids = known;
  try {
    const r = await api.listPty();
    const server = r?.ok ? r.body?.sessions : null;
    if (Array.isArray(server)) {
      ids = [...new Set([...known, ...server.map((s) => s.sessionId)])];
    }
  } catch { /* daemon blip — still DELETE what we knew */ }
  await Promise.all(ids.map((id) => api.killPty(id).catch(() => {})));
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
