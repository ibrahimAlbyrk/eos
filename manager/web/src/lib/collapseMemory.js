// Persisted sidebar collapse state: the set of collapsed tree-node ids, so
// Cmd+R / app relaunch keeps whatever the user folded. Stale ids (agents
// deleted outside the web UI) are harmless — ids are never reused — so GC is
// just a FIFO cap on top of best-effort removal at delete time.

const KEY = "cm:collapsedNodes";
const MAX_ENTRIES = 200;

export function loadCollapsedNodes(storage = globalThis.localStorage) {
  if (!storage) return new Set();
  try {
    const raw = JSON.parse(storage.getItem(KEY));
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsedNodes(set, storage = globalThis.localStorage) {
  if (!storage) return;
  try {
    // Set preserves insertion order — slicing from the end drops the oldest
    // toggles first when over the cap.
    const arr = [...set].slice(-MAX_ENTRIES);
    if (arr.length === 0) storage.removeItem(KEY);
    else storage.setItem(KEY, JSON.stringify(arr));
  } catch { /* quota/private mode */ }
}
