// Per-agent merge-conflict cache (stale-while-revalidate), mirroring diffStore.
// The resolver reads the conflicted-file list synchronously and revalidates on
// the agent's SSE activity; per-file parsed documents load lazily and the cache
// drops a file's document once it leaves the list (resolved).

import { api } from "../api/client.js";

const REFRESH_DEBOUNCE_MS = 600;
const entries = new Map();
const EMPTY = { list: null, docs: new Map() };

function entryOf(workerId) {
  let e = entries.get(workerId);
  if (!e) {
    e = { snapshot: EMPTY, inflight: null, timer: null, subs: new Set() };
    entries.set(workerId, e);
  }
  return e;
}

function emit(e) {
  for (const cb of e.subs) cb();
}

export function getSnapshot(workerId) {
  return entries.get(workerId)?.snapshot ?? EMPTY;
}

export function subscribe(workerId, cb) {
  const e = entryOf(workerId);
  e.subs.add(cb);
  return () => { e.subs.delete(cb); };
}

function setDoc(e, path, doc) {
  const docs = new Map(e.snapshot.docs);
  docs.set(path, doc);
  e.snapshot = { ...e.snapshot, docs };
  emit(e);
}

export async function loadDoc(workerId, path) {
  const e = entryOf(workerId);
  const cur = e.snapshot.docs.get(path);
  if (cur?.loading) return;
  setDoc(e, path, { loading: true, data: cur?.data });
  try {
    const data = await api.getWorkerConflictFile(workerId, path);
    setDoc(e, path, { loading: false, data });
  } catch (err) {
    setDoc(e, path, { loading: false, data: cur?.data, error: err.message });
  }
}

export function revalidate(workerId) {
  const e = entryOf(workerId);
  if (e.inflight) return e.inflight;
  e.inflight = (async () => {
    try {
      const r = await api.getWorkerConflicts(workerId);
      const present = new Set(r.files.map((f) => f.path));
      // Drop cached documents for files that are no longer conflicted; keep the
      // rest so an SSE refresh never flashes a re-parse over what's on screen.
      const docs = new Map();
      for (const [p, d] of e.snapshot.docs) if (present.has(p)) docs.set(p, d);
      e.snapshot = { list: r.files, docs };
      emit(e);
    } catch {
      // Keep the previous snapshot — stale beats empty on a network blip.
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}

// SSE worker:change fires per event; debounce into one list revalidate.
export function notifyActivity(workerId) {
  const e = entryOf(workerId);
  clearTimeout(e.timer);
  e.timer = setTimeout(() => revalidate(workerId), REFRESH_DEBOUNCE_MS);
}
