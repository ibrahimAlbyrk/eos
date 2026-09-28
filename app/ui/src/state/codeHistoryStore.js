// codeHistoryStore — the Code view's closed sessions, newest first, so the
// sidebar can reopen them: a Claude Code pane resumes its conversation, a shell
// reopens in its folder. One entry per conversation (per folder for shells), so
// closing the same session again moves it back to the top instead of piling up.
// Module singleton, persisted to localStorage (codeWorkspaceStore idiom).

const STORAGE_KEY = "cm:codeHistory";
const MAX_ENTRIES = 100;

// entries: [{ id, kind, cwd, title, claudeSessionId, color, startedAt, closedAt }]
let entries = load();
const subs = new Set();

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === "string" && typeof e.cwd === "string") : [];
  } catch {
    return [];
  }
}

function set(next) {
  entries = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage full/blocked — history still works for this run
  }
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getHistory() {
  return entries;
}

// term: a workspace pane's { kind, cwd, title, claudeSessionId, startedAt };
// color: the id of the group it was closed in.
export function recordClosed(term, color, closedAt = Date.now()) {
  if (!term?.cwd) return;
  const id = term.claudeSessionId ?? `shell:${term.cwd}`;
  const entry = {
    id,
    kind: term.kind,
    cwd: term.cwd,
    title: term.title ?? null,
    claudeSessionId: term.claudeSessionId ?? null,
    color: color ?? null,
    startedAt: term.startedAt ?? null,
    closedAt,
  };
  set([entry, ...entries.filter((e) => e.id !== id)].slice(0, MAX_ENTRIES));
}

export function forgetSession(id) {
  if (entries.some((e) => e.id === id)) set(entries.filter((e) => e.id !== id));
}

export function clearHistory() {
  if (entries.length) set([]);
}

// Test-only: reset the singleton to an empty history.
export function _resetCodeHistory() {
  entries = [];
}
