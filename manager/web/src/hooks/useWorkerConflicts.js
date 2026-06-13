import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, revalidate, notifyActivity, loadDoc } from "../state/conflictStore.js";

// Conflicted-file list + per-file parsed documents for one agent, served from
// the conflictStore cache (stale-while-revalidate). Mirrors useWorkerChanges.
export function useWorkerConflicts(workerId, live) {
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
  const load = useCallback((path) => loadDoc(workerId, path), [workerId]);

  return { list: snapshot.list, docs: snapshot.docs, refresh, loadDoc: load };
}
