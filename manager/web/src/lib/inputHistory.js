export const HISTORY_MAX = 100;

const MODES = new Set(["chat", "git", "term"]);

// Legacy entries are plain strings from before modes rode along — they all
// predate git/term tagging, so "chat" is the only honest default.
function normalizeEntry(e) {
  if (typeof e === "string") return { text: e, mode: "chat" };
  if (e && typeof e.text === "string" && MODES.has(e.mode)) return { text: e.text, mode: e.mode };
  return null;
}

export function parseHistory(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeEntry).filter(Boolean).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

// entries are {text, mode}, newest-first; index null = not navigating.
// origin stashes the pre-navigation state ({text:"", mode}) so exiting past
// the newest entry restores the mode you started in, not a hardcoded one.
// Navigation detaches implicitly: once the shown entry's text is edited,
// current.text no longer matches entries[index].text, so arrows fall back to
// default behavior. A mode toggle alone does NOT detach — the next arrow
// continues from index and re-applies that entry's mode.
export function recallUp({ entries, index, origin }, current) {
  if (index === null) {
    if (current.text !== "" || entries.length === 0) return { index: null, origin: null, recalled: null };
    return { index: 0, origin: { text: "", mode: current.mode }, recalled: entries[0] };
  }
  if (current.text !== entries[index].text) {
    if (current.text === "") return { index: 0, origin: { text: "", mode: current.mode }, recalled: entries[0] };
    return { index: null, origin: null, recalled: null };
  }
  const next = Math.min(index + 1, entries.length - 1);
  return { index: next, origin, recalled: entries[next] };
}

export function recallDown({ entries, index, origin }, current) {
  if (index === null) return { index: null, origin: null, recalled: null };
  if (current.text !== entries[index].text) return { index: null, origin: null, recalled: null };
  if (index === 0) return { index: null, origin: null, recalled: origin ?? { text: "", mode: "chat" } };
  return { index: index - 1, origin, recalled: entries[index - 1] };
}

export function commit(entries, entry, max = HISTORY_MAX) {
  const text = entry.text.trim();
  if (!text) return entries;
  const head = entries[0];
  if (head && head.text === text && head.mode === entry.mode) return entries;
  return [{ text, mode: entry.mode }, ...entries].slice(0, max);
}
