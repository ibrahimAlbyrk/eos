import { useCallback, useSyncExternalStore } from "react";

// A per-worker list published by the worker's mounted transcript (Messages) —
// the one place that already parses the events — and read by the side panel
// and the Environment popover, so they never re-parse and always match it.
export function createWorkerListStore() {
  const EMPTY = Object.freeze([]);
  const byWorker = new Map(); // workerId -> list
  const listeners = new Map(); // workerId -> Set<fn>

  function publish(workerId, list) {
    if (!workerId || byWorker.get(workerId) === list) return;
    byWorker.set(workerId, list);
    for (const fn of listeners.get(workerId) ?? []) fn();
  }

  function get(workerId) {
    return byWorker.get(workerId) ?? EMPTY;
  }

  function subscribe(workerId, fn) {
    if (!listeners.has(workerId)) listeners.set(workerId, new Set());
    listeners.get(workerId).add(fn);
    return () => listeners.get(workerId)?.delete(fn);
  }

  function useList(workerId) {
    const sub = useCallback((fn) => (workerId ? subscribe(workerId, fn) : () => {}), [workerId]);
    const get = useCallback(() => (workerId ? byWorker.get(workerId) ?? EMPTY : EMPTY), [workerId]);
    return useSyncExternalStore(sub, get, get);
  }

  return { publish, get, useList };
}
