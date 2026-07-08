// Git Diff panel cache (stale-while-revalidate) — the diffStore idiom keyed by
// `${cwd} ${scopeKey}` instead of workerId, so one panel instance per pane can
// show any repo dir at either the working-tree scope ("all") or a single
// commit's scope ("commit:<sha>"). Commit-scope entries are immutable history:
// fetched once, never revalidated, capped per cwd with oldest-first eviction.

import { api } from "../api/client.js";

const REFRESH_DEBOUNCE_MS = 800;
const COMMIT_CACHE_PER_CWD = 8;

const entries = new Map();

const EMPTY = { changes: null, patches: new Map() };

export function scopeKeyOf(scope) {
  return scope.kind === "commit" ? `commit:${scope.sha}` : "all";
}

export function gitDiffKey(cwd, scope) {
  return `${cwd} ${scopeKeyOf(scope)}`;
}

function entryOf(key) {
  let e = entries.get(key);
  if (!e) {
    e = { snapshot: EMPTY, inflight: null, timer: null, subs: new Set() };
    entries.set(key, e);
  }
  return e;
}

function emit(e) {
  for (const cb of e.subs) cb();
}

export function getSnapshot(key) {
  return entries.get(key)?.snapshot ?? EMPTY;
}

export function subscribe(key, cb) {
  const e = entryOf(key);
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

export async function loadPatch(cwd, scope, file) {
  const e = entryOf(gitDiffKey(cwd, scope));
  const cur = e.snapshot.patches.get(file.path);
  if (cur?.loading) return;
  setPatch(e, file.path, { loading: true, data: cur?.data });
  try {
    const sha = scope.kind === "commit" ? scope.sha : undefined;
    const data = await api.getGitFileDiff(cwd, file.path, { oldPath: file.oldPath, sha });
    setPatch(e, file.path, { loading: false, data });
  } catch (err) {
    setPatch(e, file.path, { loading: false, data: cur?.data, error: err.message });
  }
}

// Keep at most COMMIT_CACHE_PER_CWD commit-scope entries per cwd: their patches
// can be hundreds of KB and history browsing accumulates them. Subscribed
// entries (a mounted panel) are never evicted — dropping one would blank it.
function evictCommits(cwd) {
  const prefix = `${cwd} commit:`;
  const evictable = [...entries.keys()].filter(
    (k) => k.startsWith(prefix) && entries.get(k).subs.size === 0,
  );
  const excess = [...entries.keys()].filter((k) => k.startsWith(prefix)).length - COMMIT_CACHE_PER_CWD;
  for (const k of evictable.slice(0, Math.max(0, excess))) entries.delete(k);
}

export function revalidate(cwd, scope) {
  const key = gitDiffKey(cwd, scope);
  const e = entryOf(key);
  // Commit scope is immutable — the first successful fetch is final.
  if (scope.kind === "commit" && e.snapshot.changes) return Promise.resolve();
  if (e.inflight) return e.inflight;
  e.inflight = (async () => {
    try {
      const sha = scope.kind === "commit" ? scope.sha : undefined;
      const r = await api.getGitChanges(cwd, { sha, patches: true });
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
      if (scope.kind === "commit") evictCommits(cwd);
      // Refetch any kept-from-cache patch whose counts moved — it is stale.
      for (const f of r.files) {
        if (f.patch !== undefined || f.binary) continue;
        const old = prevByPath.get(f.path);
        const moved = old && (old.insertions !== f.insertions || old.deletions !== f.deletions);
        if (moved && patches.has(f.path)) loadPatch(cwd, scope, f);
      }
    } catch {
      // Keep the previous snapshot — stale beats empty on a network blip.
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}

// SSE git:change fires per touched path; debounce into one revalidate.
export function notifyActivity(cwd, scope) {
  const e = entryOf(gitDiffKey(cwd, scope));
  clearTimeout(e.timer);
  e.timer = setTimeout(() => revalidate(cwd, scope), REFRESH_DEBOUNCE_MS);
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  for (const e of entries.values()) clearTimeout(e.timer);
  entries.clear();
}
