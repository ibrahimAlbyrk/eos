// Unsent edits of drafts, kept in this window's profile so paging away loses
// nothing: `eos:edit:<itemId>` → { doc, rev, at }, at most 20, none older
// than seven days. A storage access that fails is ignored: the edits then
// live only on the screen.

const PREFIX = "eos:edit:";
export const EDITS_MAX = 20;
export const EDIT_TTL_MS = 7 * 24 * 3_600_000;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key) {
  try {
    const value = JSON.parse(storage()?.getItem(key) ?? "null");
    return Array.isArray(value?.doc?.parts) && typeof value.at === "number" ? value : null;
  } catch {
    return null;
  }
}

function remove(key) {
  try {
    storage()?.removeItem(key);
  } catch { /* ignored: the edit expires on its own */ }
}

// Every kept edit's key with when it was written.
function keptEdits() {
  const s = storage();
  const found = [];
  try {
    for (let i = 0; i < (s?.length ?? 0); i++) {
      const key = s.key(i);
      if (key?.startsWith(PREFIX)) found.push({ key, at: read(key)?.at ?? 0 });
    }
  } catch { /* ignored */ }
  return found;
}

// The unsent edit of an item, or null; an expired one is dropped.
export function readEdit(itemId, now) {
  const value = read(PREFIX + itemId);
  if (value && now - value.at > EDIT_TTL_MS) {
    remove(PREFIX + itemId);
    return null;
  }
  return value;
}

// Keeps the edit; expired edits go, and the oldest beyond twenty.
export function writeEdit(itemId, doc, rev, now) {
  try {
    storage()?.setItem(PREFIX + itemId, JSON.stringify({ doc, rev, at: now }));
  } catch {
    return;
  }
  const kept = keptEdits().filter(({ key, at }) => (now - at > EDIT_TTL_MS ? (remove(key), false) : true));
  kept.sort((a, b) => a.at - b.at);
  for (const { key } of kept.slice(0, Math.max(0, kept.length - EDITS_MAX))) remove(key);
}

export function dropEdit(itemId) {
  remove(PREFIX + itemId);
}

// Edits of a draft that a newer one replaced, shown read-only beside the
// newer draft (08 G32): newer item id → the edited doc. Kept until reload.
const carried = new Map();

export function carryEdits(newItemId, doc) {
  carried.set(newItemId, doc);
}

export const carriedEdits = (itemId) => carried.get(itemId) ?? null;

export function _resetCarried() {
  carried.clear();
}
