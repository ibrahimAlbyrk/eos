// Per-agent diff cache (stale-while-revalidate). The Changes panel reads the
// snapshot for its workerId synchronously — reopening the panel renders the
// cached list + patches immediately and revalidates in the background. Patch
// entries keep their previous data while reloading, so an SSE-driven refresh
// never flashes a "Loading" state over content the user is reading.

import { api } from "../api/client.js";

const REFRESH_DEBOUNCE_MS = 800;

const entries = new Map();

const EMPTY = { changes: null, patches: new Map() };

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
  return () => {
    e.subs.delete(cb);
  };
}

function setPatch(e, path, patch) {
  const patches = new Map(e.snapshot.patches);
  patches.set(path, patch);
  e.snapshot = { ...e.snapshot, patches };
  emit(e);
}

export async function loadPatch(workerId, file) {
  const e = entryOf(workerId);
  const cur = e.snapshot.patches.get(file.path);
  if (cur?.loading) return;
  setPatch(e, file.path, { loading: true, data: cur?.data });
  try {
    const data = await api.getWorkerFileDiff(workerId, file.path, file.oldPath);
    setPatch(e, file.path, { loading: false, data });
  } catch (err) {
    setPatch(e, file.path, { loading: false, data: cur?.data, error: err.message });
  }
}

export function revalidate(workerId) {
  const e = entryOf(workerId);
  if (e.inflight) return e.inflight;
  e.inflight = (async () => {
    try {
      const r = await api.getWorkerChanges(workerId, { patches: true });
      const prevFiles = e.snapshot.changes?.files ?? [];
      const prevByPath = new Map(prevFiles.map((f) => [f.path, f]));
      const patches = new Map();
      for (const f of r.files) {
        if (f.patch !== undefined || f.binary) {
          // Embedded patch — split from the SAME git diff as the listing, so
          // it always replaces whatever was cached.
          patches.set(f.path, {
            loading: false,
            data: { path: f.path, patch: f.patch ?? "", binary: Boolean(f.binary), truncated: Boolean(f.truncated) },
          });
        } else {
          // No embedded patch (untracked / over budget) — keep the cached one.
          const prev = e.snapshot.patches.get(f.path);
          if (prev) patches.set(f.path, prev);
        }
      }
      e.snapshot = { changes: r, patches };
      emit(e);
      // Refetch any kept-from-cache patch whose counts moved — it is stale.
      for (const f of r.files) {
        if (f.patch !== undefined || f.binary) continue;
        const old = prevByPath.get(f.path);
        const moved = old && (old.insertions !== f.insertions || old.deletions !== f.deletions);
        if (moved && patches.has(f.path)) loadPatch(workerId, f);
      }
    } catch {
      // Keep the previous snapshot — stale beats empty on a network blip.
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}

// SSE worker:change fires per tool event; debounce into one revalidate.
export function notifyActivity(workerId) {
  const e = entryOf(workerId);
  clearTimeout(e.timer);
  e.timer = setTimeout(() => revalidate(workerId), REFRESH_DEBOUNCE_MS);
}
