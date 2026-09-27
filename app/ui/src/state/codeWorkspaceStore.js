// codeWorkspaceStore — the Code view's terminal workspace: named, colored pane
// groups, each a split layout (the same BSP tree the Agents view uses,
// lib/paneLayout) whose panes each hold ONE interactive PTY session, plus the
// folder new terminals open in. One group is on screen at a time; `tree` and
// `focusedId` on the snapshot are the active group's, so pane actions without a
// leaf id (⌘T, ⌘1..9, drag-rearrange) act on what's visible. A module
// singleton (ptyPanelStore idiom) because the sidebar, the pane grid and the
// hotkeys render in different subtrees and must share one source of truth.
//
// Persisted to localStorage so a reload reattaches: the daemon keeps every PTY
// alive, TerminalView replays its scrollback, and reconcile() restarts panes
// whose session died meanwhile (daemon restart, app quit, reboot).

import { api } from "../api/client.js";
import {
  MAX_PANES, leaf, leaves, leafCount, findLeaf, isValidTree,
  splitLeaf, removeLeaf, setRatio, moveLeaf, swapLeaves,
} from "../lib/paneLayout.js";
import { GROUP_COLORS, nextGroupColor } from "../lib/groupColors.js";
import { registerSessionTracker } from "./ptyPanelStore.js";

// Shown on the launcher; the daemon builds the actual command line (mirrors
// CLAUDE_COMMAND in contracts/src/http.ts — the user's `cc` alias). Each pane's
// conversation id is pinned daemon-side at launch, and the session hook keeps it
// current (/clear, /resume), so reconcile() can resume that conversation after
// the PTY dies.
export const CLAUDE_COMMAND = "claude --model opus --dangerously-skip-permissions";

export const KINDS = { claude: "claude", shell: "shell" };

const STORAGE_KEY = "cm:codeWorkspace";
// Seed size for a new PTY; TerminalView refits and resizes it on mount.
const SEED = { cols: 120, rows: 32 };

// groups: [{ id, name, color, tree, focusedId }] in sidebar order
// terms: leafId -> { sessionId, kind, cwd, title, claudeSessionId } (all groups)
// errors: leafId -> message (a failed launch, shown by that pane's launcher)
let state = load();
const launching = new Set(); // leafIds with a create in flight
const subs = new Set();

function newGroup(groups) {
  const t = leaf();
  const names = new Set(groups.map((g) => g.name));
  let n = groups.length + 1;
  while (names.has(`Group ${n}`)) n += 1;
  return { id: crypto.randomUUID(), name: `Group ${n}`, color: nextGroupColor(groups.map((g) => g.color)), tree: t, focusedId: t.id };
}

// Function declarations, not arrows: load() runs at module init, before any const is set.
function isValidGroup(g) {
  return g && typeof g.id === "string" && typeof g.name === "string" && isValidTree(g.tree);
}

function normalizeGroup(g) {
  return {
    id: g.id,
    name: g.name,
    color: typeof g.color === "string" ? g.color : GROUP_COLORS[0].id,
    tree: g.tree,
    focusedId: findLeaf(g.tree, g.focusedId) ? g.focusedId : leaves(g.tree)[0].id,
  };
}

// Mirror the active group's layout onto the snapshot (see the header).
function withActive(s) {
  const g = s.groups.find((x) => x.id === s.activeGroupId) ?? s.groups[0];
  return { ...s, activeGroupId: g.id, tree: g.tree, focusedId: g.focusedId };
}

function fresh() {
  return withActive({ cwd: null, groups: [newGroup([])], activeGroupId: null, terms: {}, errors: {} });
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    // A workspace saved before groups existed is one layout: it becomes the first group.
    const raw = Array.isArray(s?.groups) ? s.groups
      : isValidTree(s?.tree) ? [{ ...newGroup([]), tree: s.tree, focusedId: s.focusedId }]
      : [];
    const groups = raw.filter(isValidGroup).map(normalizeGroup);
    if (groups.length) {
      return withActive({ cwd: s.cwd ?? null, groups, activeGroupId: s.activeGroupId, terms: s.terms ?? {}, errors: {} });
    }
  } catch {
    // corrupt entry → fresh workspace
  }
  return fresh();
}

function set(patch) {
  state = withActive({ ...state, ...patch });
  try {
    const { cwd, groups, activeGroupId, terms } = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ cwd, groups, activeGroupId, terms }));
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

const groupOfLeaf = (leafId) => state.groups.find((g) => findLeaf(g.tree, leafId)) ?? null;

// Patch one group's fields (and, optionally, top-level state in the same emit).
function setGroup(id, groupPatch, patch = {}) {
  set({ ...patch, groups: state.groups.map((g) => (g.id === id ? { ...g, ...groupPatch } : g)) });
}

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

export function clearCwd(cwd) {
  if (cwd === state.cwd) set({ cwd: null });
}

export function focusPane(leafId) {
  if (leafId !== state.focusedId && findLeaf(state.tree, leafId)) setGroup(state.activeGroupId, { focusedId: leafId });
}

export function focusPaneByIndex(i) {
  const l = leaves(state.tree)[i];
  if (l) focusPane(l.id);
}

export function setSplitRatio(splitId, ratio) {
  const tree = setRatio(state.tree, splitId, ratio);
  if (tree !== state.tree) setGroup(state.activeGroupId, { tree });
}

// Start a session in an EMPTY pane. `cwd` defaults to the workspace folder.
export function launch(leafId, kind = KINDS.claude, cwd = state.cwd) {
  return start(leafId, { kind, cwd, title: null, claudeSessionId: null }, kind === KINDS.claude ? {} : undefined);
}

// `claude`: start Claude Code (`{ resume }` continues a conversation) instead of a shell.
async function start(leafId, term, claude) {
  if (!term.cwd || launching.has(leafId) || state.terms[leafId]) return;
  launching.add(leafId);
  set({ errors: without(state.errors, leafId) });
  try {
    const r = await api.createPty({ ...SEED, cwd: term.cwd, claude });
    const s = r?.body;
    if (!r?.ok || !s?.sessionId) throw new Error(s?.error ?? `could not start terminal (${r?.status ?? "no response"})`);
    // The pane may have been closed while the create was in flight.
    if (!groupOfLeaf(leafId)) { api.killPty(s.sessionId).catch(() => {}); return; }
    set({ terms: { ...state.terms, [leafId]: { ...term, sessionId: s.sessionId, claudeSessionId: s.claudeSessionId ?? null } } });
  } catch (e) {
    set({ errors: { ...state.errors, [leafId]: e instanceof Error ? e.message : String(e) } });
  } finally {
    launching.delete(leafId);
  }
}

// Split `leafId` and start a session in the new pane, in the source pane's
// folder (like splitting a terminal in iTerm) — else the workspace folder.
export function splitPane(leafId, dir, kind = KINDS.claude) {
  const g = groupOfLeaf(leafId);
  if (!g) return false;
  const { tree, newId } = splitLeaf(g.tree, leafId, dir, "after", null);
  if (!newId) return false;
  const cwd = state.terms[leafId]?.cwd ?? state.cwd;
  setGroup(g.id, { tree, focusedId: newId });
  launch(newId, kind, cwd);
  return true;
}

// ⌘T / sidebar "New …": fill the focused pane when it's empty, else split it.
export function openTerminal(kind = KINDS.claude) {
  const id = state.focusedId;
  if (!state.terms[id]) { launch(id, kind); return true; }
  const { tree, newId } = splitLeaf(state.tree, id, "row", "after", null);
  if (!newId) return false;
  setGroup(state.activeGroupId, { tree, focusedId: newId });
  launch(newId, kind);
  return true;
}

export const canSplit = () => leafCount(state.tree) < MAX_PANES;

// Remove a pane from whichever group holds it (its parent split collapses to
// the sibling). A group's last pane is never removed — it's emptied back to the
// launcher instead.
function dropPane(leafId) {
  const terms = without(state.terms, leafId);
  const errors = without(state.errors, leafId);
  const g = groupOfLeaf(leafId);
  if (!g || leafCount(g.tree) <= 1) { set({ terms, errors }); return; }
  const prevIdx = leaves(g.tree).findIndex((l) => l.id === leafId);
  const tree = removeLeaf(g.tree, leafId);
  let focusedId = g.focusedId;
  if (!findLeaf(tree, focusedId)) {
    const list = leaves(tree);
    focusedId = (list[Math.min(Math.max(prevIdx, 0), list.length - 1)] ?? list[0]).id;
  }
  setGroup(g.id, { tree, focusedId }, { terms, errors });
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

// The pane's Claude Code conversation changed (reported by the session hook).
export function setClaudeSession(leafId, claudeSessionId) {
  const t = state.terms[leafId];
  if (!t || t.claudeSessionId === claudeSessionId) return;
  set({ terms: { ...state.terms, [leafId]: { ...t, claudeSessionId } } });
}

// Drag a pane (from the sidebar list) onto another: an edge zone moves it there
// as a new split, the center swaps the two.
export function dropPaneOn(targetId, zone, srcId) {
  const tree = zone.kind === "split"
    ? moveLeaf(state.tree, srcId, targetId, zone.dir, zone.side)
    : swapLeaves(state.tree, srcId, targetId);
  if (tree !== state.tree) setGroup(state.activeGroupId, { tree, focusedId: srcId });
}

// Restart, in place, panes whose session no longer exists daemon-side (daemon
// restart, app quit, reboot): Claude panes resume their pinned conversation,
// shells reopen in the same folder. A Claude pane with no pinned id (persisted
// before ids were pinned) has nothing to resume and is dropped.
export async function reconcile() {
  let sessions;
  try {
    const r = await api.listPty();
    sessions = r?.ok ? r.body?.sessions : null;
  } catch { return; }
  if (!Array.isArray(sessions)) return;
  const alive = new Set(sessions.filter((s) => s.alive).map((s) => s.sessionId));
  for (const [leafId, t] of Object.entries(state.terms)) {
    if (alive.has(t.sessionId)) continue;
    if (t.kind === KINDS.claude && !t.claudeSessionId) { dropPane(leafId); continue; }
    set({ terms: without(state.terms, leafId) });
    start(leafId, t, t.kind === KINDS.claude ? { resume: t.claudeSessionId } : undefined);
  }
  for (const s of sessions) adoptRemote(s);
}

// A session opened from a paired phone becomes a pane in a group of its own,
// named for its folder — without taking the screen from what is open now.
export function adoptRemote(session) {
  if (!session?.remote || !session.alive) return;
  if (Object.values(state.terms).some((t) => t.sessionId === session.sessionId)) return;
  const g = newGroup(state.groups);
  const folder = session.cwd.split("/").filter(Boolean).pop() ?? session.cwd;
  set({
    groups: [...state.groups, { ...g, name: `Phone · ${folder}` }],
    terms: {
      ...state.terms,
      [g.focusedId]: {
        sessionId: session.sessionId, kind: session.kind, cwd: session.cwd,
        title: session.title, claudeSessionId: session.claudeSessionId,
      },
    },
  });
}

// ── Groups ──────────────────────────────────────────────────────────────────
// A new group starts as one empty pane (the launcher) and comes on screen.
export function createGroup() {
  const g = newGroup(state.groups);
  set({ groups: [...state.groups, g], activeGroupId: g.id });
  return g.id;
}

export function switchGroup(id) {
  if (id !== state.activeGroupId && state.groups.some((g) => g.id === id)) set({ activeGroupId: id });
}

export function switchGroupByIndex(i) {
  const g = state.groups[i];
  if (g) switchGroup(g.id);
}

// ⌃⇥ / ⌃⇧⇥: step to the next / previous group, wrapping around.
export function cycleGroup(step) {
  const n = state.groups.length;
  const i = state.groups.findIndex((g) => g.id === state.activeGroupId);
  switchGroup(state.groups[(i + step + n) % n].id);
}

function updateGroup(id, patch) {
  const g = state.groups.find((x) => x.id === id);
  if (g && Object.keys(patch).some((k) => g[k] !== patch[k])) setGroup(id, patch);
}

export function renameGroup(id, name) {
  const trimmed = String(name ?? "").trim();
  if (trimmed) updateGroup(id, { name: trimmed });
}

export function setGroupColor(id, color) {
  updateGroup(id, { color });
}

// Deleting a group ends its sessions. The last group is replaced by a fresh one,
// so there is always a group on screen.
export function deleteGroup(id) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) return;
  let { terms, errors } = state;
  for (const l of leaves(g.tree)) {
    if (terms[l.id]) api.killPty(terms[l.id].sessionId).catch(() => {});
    terms = without(terms, l.id);
    errors = without(errors, l.id);
  }
  const idx = state.groups.indexOf(g);
  const rest = state.groups.filter((x) => x !== g);
  const groups = rest.length ? rest : [newGroup([])];
  const activeGroupId = id === state.activeGroupId ? groups[Math.min(idx, groups.length - 1)].id : state.activeGroupId;
  set({ groups, activeGroupId, terms, errors });
}

// Test-only: reset the singleton to a fresh workspace.
export function _resetCodeWorkspace() {
  state = fresh();
  launching.clear();
}
