// fileWatchStore — the single owner of the code-view right-panel's file watches.
// A module singleton (the toastStore idiom) because its subscribers are scattered
// FileViewer instances that need no shared React context and must survive duplicate
// mounts. Distinct from explorerStore's watch lifecycle, which the Files tab owns
// via expand/collapse; this store owns only the watches the code-view FileViewer
// needs so an open file live-refreshes when it changes on disk.
//
// Per-dir ref-count: several files open in the same dir share ONE api.watchDir(dir,
// dir); the watch is dropped only when the last subscriber for that dir leaves.
// Per-path fan-out is fed from fsChangeBus (published by useLive beside the
// explorer's own reconcile). resubscribe() re-arms every active dir watch after an
// SSE reconnect, since a daemon restart drops its in-memory watches.

import { useEffect, useRef } from "react";
import { api } from "../api/client.js";
import { subscribeFsChange } from "./fsChangeBus.js";
import { parentDir } from "../lib/explorerApi.js";

const dirCounts = new Map(); // dir -> number of active subscriptions in that dir
const pathSubs = new Map(); // path -> Set<{ onChange, onRemove }>

function retainDir(dir) {
  const count = dirCounts.get(dir) ?? 0;
  dirCounts.set(dir, count + 1);
  if (count === 0) api.watchDir(dir, dir).catch(() => {});
}

function releaseDir(dir) {
  const count = dirCounts.get(dir);
  if (count == null) return;
  if (count <= 1) { dirCounts.delete(dir); api.unwatchDir(dir, dir).catch(() => {}); }
  else dirCounts.set(dir, count - 1);
}

// Start watching `path`; returns an unsubscribe. Each call retains the parent dir
// (ref-counted) so N viewers of one dir arm a single watch.
export function watchFile(path, handlers) {
  const dir = parentDir(path);
  let set = pathSubs.get(path);
  if (!set) { set = new Set(); pathSubs.set(path, set); }
  set.add(handlers);
  retainDir(dir);
  return () => {
    const s = pathSubs.get(path);
    if (s) { s.delete(handlers); if (s.size === 0) pathSubs.delete(path); }
    releaseDir(dir);
  };
}

// Re-arm every active dir watch (SSE reconnect after a daemon restart).
export function resubscribe() {
  for (const dir of dirCounts.keys()) api.watchDir(dir, dir).catch(() => {});
}

subscribeFsChange((payload) => {
  const changes = payload?.changes;
  if (!Array.isArray(changes)) return;
  for (const ch of changes) {
    const set = pathSubs.get(ch.path);
    if (!set) continue;
    for (const h of [...set]) {
      if (ch.kind === "unlink") h.onRemove?.();
      else if (ch.kind === "change") h.onChange?.();
    }
  }
});

// Thin hook: watch `path` for the lifetime of the mount. onChange/onRemove are read
// through a ref so the effect re-subscribes only when the path changes — the
// callbacks are fresh closures each render (they close over dirty/saving) but must
// not churn the watch.
export function useFileWatch(path, { onChange, onRemove } = {}) {
  const cbRef = useRef({ onChange, onRemove });
  cbRef.current = { onChange, onRemove };
  useEffect(() => {
    if (!path) return undefined;
    const handlers = {
      onChange: () => cbRef.current.onChange?.(),
      onRemove: () => cbRef.current.onRemove?.(),
    };
    return watchFile(path, handlers);
  }, [path]);
}

// Test-only: reset the module singleton between cases.
export function _resetForTest() {
  dirCounts.clear();
  pathSubs.clear();
}
