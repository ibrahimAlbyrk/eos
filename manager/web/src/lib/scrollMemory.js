// Per-agent scroll position persistence. An entry exists only when the user
// scrolled away from the bottom; no entry = default stick-to-bottom.

const KEY = "cm:scrollPos";
const MAX_ENTRIES = 50;

function load(storage) {
  try {
    const raw = JSON.parse(storage.getItem(KEY));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function persist(storage, map) {
  try { storage.setItem(KEY, JSON.stringify(map)); } catch { /* quota/private mode */ }
}

export function loadScrollPos(id, storage = globalThis.localStorage) {
  if (!id || !storage) return null;
  const v = load(storage)[id];
  return typeof v === "number" ? v : null;
}

export function saveScrollPos(id, top, storage = globalThis.localStorage) {
  if (!id || !storage) return;
  const map = load(storage);
  // Re-insert so the key moves to the end; pruning drops the oldest first.
  delete map[id];
  map[id] = top;
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete map[keys[i]];
  persist(storage, map);
}

export function clearScrollPos(id, storage = globalThis.localStorage) {
  if (!id || !storage) return;
  const map = load(storage);
  if (!(id in map)) return;
  delete map[id];
  persist(storage, map);
}
