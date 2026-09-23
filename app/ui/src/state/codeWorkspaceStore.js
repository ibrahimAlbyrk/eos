// codeWorkspaceStore — the Code view's terminal workspace: a split layout (the
// same BSP tree the Agents view uses, lib/paneLayout) whose panes each hold ONE
// interactive PTY session, plus the folder new terminals open in. A module
// singleton (ptyPanelStore idiom) because the sidebar, the pane grid and the
// hotkeys render in different subtrees and must share one source of truth.
//
// Persisted to localStorage so a reload reattaches: the daemon keeps every PTY
// alive, TerminalView replays its scrollback, and reconcile() drops panes whose
// session died meanwhile (e.g. a daemon restart).

import { api } from "../api/client.js";
import {
  MAX_PANES, leaf, leaves, leafCount, findLeaf, isValidTree,
  splitLeaf, removeLeaf, setRatio, moveLeaf, swapLeaves,
} from "../lib/paneLayout.js";
import { registerSessionTracker } from "./ptyPanelStore.js";

// Expansion of the user's `cc` shell alias — Claude Code starts with it.
export const CLAUDE_COMMAND = "claude --model opus --dangerously-skip-permissions";

export const KINDS = { claude: "claude", shell: "shell" };

const STORAGE_KEY = "cm:codeWorkspace";
// Seed size for a new PTY; TerminalView refits and resizes it on mount.
const SEED = { cols: 120, rows: 32 };

// terms: leafId -> { sessionId, kind, cwd, title }
// errors: leafId -> message (a failed launch, shown by that pane's launcher)
let state = load();
const launching = new Set(); // leafIds with a create in flight
const subs = new Set();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (s && isValidTree(s.tree)) {
      const focusedId = findLeaf(s.tree, s.focusedId) ? s.focusedId : leaves(s.tree)[0].id;
      return { cwd: s.cwd ?? null, tree: s.tree, focusedId, terms: s.terms ?? {}, errors: {} };
    }
  } catch {
    // corrupt entry → fresh workspace
  }
  const t = leaf();
  return { cwd: null, tree: t, focusedId: t.id, terms: {}, errors: {} };
}

function set(patch) {
  state = { ...state, ...patch };
  try {
    const { cwd, tree, focusedId, terms } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cwd, tree, focusedId, terms }));
  } catch {
    // storage full/blocked — the in-memory workspace still works
  }
  for (const cb of subs) cb();
}

const without = (obj, key) => {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
};

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getWorkspace() {
  return state;
}

registerSessionTracker(() => Object.values(state.terms).map((t) => t.sessionId));

export function setCwd(cwd) {
  if (cwd && cwd !== state.cwd) set({ cwd });
}

export function focusPane(leafId) {
  if (leafId !== state.focusedId && findLeaf(state.tree, leafId)) set({ focusedId: leafId });
}

export function focusPaneByIndex(i) {
  const l = leaves(state.tree)[i];
  if (l) focusPane(l.id);
}

export function setSplitRatio(splitId, ratio) {
  const tree = setRatio(state.tree, splitId, ratio);
  if (tree !== state.tree) set({ tree });
}

// Start a session in an EMPTY pane. `cwd` defaults to the workspace folder.
export async function launch(leafId, kind = KINDS.claude, cwd = state.cwd) {
  if (!cwd || launching.has(leafId) || state.terms[leafId]) return;
  launching.add(leafId);
  set({ errors: without(state.errors, leafId) });
  try {
    const command = kind === KINDS.claude ? CLAUDE_COMMAND : undefined;
    const r = await api.createPty({ ...SEED, cwd, command });
    const s = r?.body;
    if (!r?.ok || !s?.sessionId) throw new Error(s?.error ?? `could not start terminal (${r?.status ?? "no response"})`);
    // The pane may have been closed while the create was in flight.
    if (!findLeaf(state.tree, leafId)) { api.killPty(s.sessionId).catch(() => {}); return; }
    set({ terms: { ...state.terms, [leafId]: { sessionId: s.sessionId, kind, cwd, title: null } } });
  } catch (e) {
    set({ errors: { ...state.errors, [leafId]: e instanceof Error ? e.message : String(e) } });
  } finally {
    launching.delete(leafId);
  }
}

// Split `leafId` and start a session in the new pane, in the source pane's
// folder (like splitting a terminal in iTerm) — else the workspace folder.
export function splitPane(leafId, dir, kind = KINDS.claude) {
  const { tree, newId } = splitLeaf(state.tree, leafId, dir, "after", null);
  if (!newId) return false;
  const cwd = state.terms[leafId]?.cwd ?? state.cwd;
  set({ tree, focusedId: newId });
  launch(newId, kind, cwd);
  return true;
}

// ⌘T / sidebar "New …": fill the focused pane when it's empty, else split it.
export function openTerminal(kind = KINDS.claude) {
  const id = state.focusedId;
  if (!state.terms[id]) { launch(id, kind); return true; }
  const { tree, newId } = splitLeaf(state.tree, id, "row", "after", null);
  if (!newId) return false;
  set({ tree, focusedId: newId });
  launch(newId, kind);
  return true;
}

export const canSplit = () => leafCount(state.tree) < MAX_PANES;

// Remove a pane (its parent split collapses to the sibling). The last pane is
// never removed — it's emptied back to the launcher instead.
function dropPane(leafId) {
  const terms = without(state.terms, leafId);
  const errors = without(state.errors, leafId);
  if (leafCount(state.tree) <= 1) { set({ terms, errors }); return; }
  const prevIdx = leaves(state.tree).findIndex((l) => l.id === leafId);
  const tree = removeLeaf(state.tree, leafId);
  let focusedId = state.focusedId;
  if (!findLeaf(tree, focusedId)) {
    const list = leaves(tree);
    focusedId = (list[Math.min(Math.max(prevIdx, 0), list.length - 1)] ?? list[0]).id;
  }
  set({ tree, focusedId, terms, errors });
}

export function closePane(leafId) {
  const t = state.terms[leafId];
  if (t) api.killPty(t.sessionId).catch(() => {});
  dropPane(leafId);
}

// The shell exited (the user typed `exit`): close its pane, like a terminal tab.
export function sessionExited(sessionId) {
  const leafId = Object.keys(state.terms).find((id) => state.terms[id].sessionId === sessionId);
  if (leafId) dropPane(leafId);
}

// Latest terminal title (OSC 0/2 — Claude Code sets it to the conversation
// topic). Leading status glyphs are stripped; only a real change re-emits, so a
// spinner animating in the title doesn't churn the store.
export function setTitle(leafId, raw) {
  const t = state.terms[leafId];
  const title = String(raw ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || null;
  if (!t || t.title === title) return;
  set({ terms: { ...state.terms, [leafId]: { ...t, title } } });
}

// Drag a pane (from the sidebar list) onto another: an edge zone moves it there
// as a new split, the center swaps the two.
export function dropPaneOn(targetId, zone, srcId) {
  const tree = zone.kind === "split"
    ? moveLeaf(state.tree, srcId, targetId, zone.dir, zone.side)
    : swapLeaves(state.tree, srcId, targetId);
  if (tree !== state.tree) set({ tree, focusedId: srcId });
}

// Drop panes whose session no longer exists daemon-side (daemon restart, or a
// shell that exited while this view wasn't mounted).
export async function reconcile() {
  let sessions;
  try {
    const r = await api.listPty();
    sessions = r?.ok ? r.body?.sessions : null;
  } catch { return; }
  if (!Array.isArray(sessions)) return;
  const alive = new Set(sessions.filter((s) => s.alive).map((s) => s.sessionId));
  for (const [leafId, t] of Object.entries(state.terms)) {
    if (!alive.has(t.sessionId)) dropPane(leafId);
  }
}

// Test-only: reset the singleton to a fresh workspace.
export function _resetCodeWorkspace() {
  const t = leaf();
  state = { cwd: null, tree: t, focusedId: t.id, terms: {}, errors: {} };
  launching.clear();
}
