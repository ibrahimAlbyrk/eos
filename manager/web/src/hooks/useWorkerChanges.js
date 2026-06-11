import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, revalidate, notifyActivity, loadPatch } from "../state/diffStore.js";

// Changed-file list + per-file patches for one agent, served from the
// diffStore cache (stale-while-revalidate): the panel renders the cached
// snapshot synchronously and revalidates on mount and on the agent's own
// SSE activity (debounced inside the store).
export function useWorkerChanges(workerId, live) {
  const sub = useCallback((cb) => subscribe(workerId, cb), [workerId]);
  const get = useCallback(() => getSnapshot(workerId), [workerId]);
  const snapshot = useSyncExternalStore(sub, get);

  useEffect(() => {
    revalidate(workerId);
  }, [workerId]);

  useEffect(() => {
    if (live.eventSignal.workerId !== workerId) return;
    notifyActivity(workerId);
  }, [live.eventSignal.tick, live.eventSignal.workerId, workerId]);

  const refresh = useCallback(() => revalidate(workerId), [workerId]);
  const load = useCallback((file) => loadPatch(workerId, file), [workerId]);

  return { changes: snapshot.changes, patches: snapshot.patches, refresh, loadPatch: load };
}
