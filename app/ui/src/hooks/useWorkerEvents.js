// useWorkerEvents — thin adapter over state/eventsStore.js. The window cache,
// pagination, polling and read-ahead prefetch all live in the store (module
// scope), so a loaded transcript survives unmounts and agent switches; this
// hook only subscribes the component to its agent's snapshot.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  attach, fetchDelta as storeFetchDelta, getSnapshot, loadOlder as storeLoadOlder,
  refetchNewest as storeRefetchNewest, setFollowing as storeSetFollowing, subscribe,
} from "../state/eventsStore.js";
import { retainWorker } from "../state/streamFocus.js";

const noopSubscribe = () => () => {};

export function useWorkerEvents(workerId, { onNewest } = {}) {
  const onNewestRef = useRef(onNewest);
  onNewestRef.current = onNewest;

  const sub = useCallback(
    (cb) => (workerId ? subscribe(workerId, cb) : noopSubscribe()),
    [workerId],
  );
  const get = useCallback(() => getSnapshot(workerId), [workerId]);
  const snap = useSyncExternalStore(sub, get);

  useEffect(() => {
    if (!workerId) return;
    const detach = attach(workerId, { onNewest: (id, rows) => onNewestRef.current?.(id, rows) });
    // On screen: its live tokens stream to this tab.
    const release = retainWorker(workerId);
    return () => { release(); detach(); };
  }, [workerId]);

  const loadOlder = useCallback(() => storeLoadOlder(workerId), [workerId]);
  const fetchDelta = useCallback(() => storeFetchDelta(workerId), [workerId]);
  const refetchNewest = useCallback(() => storeRefetchNewest(workerId), [workerId]);
  const setFollowing = useCallback(
    (following) => { if (workerId) storeSetFollowing(workerId, following); },
    [workerId],
  );

  return {
    events: snap.events,
    eventsFor: snap.eventsFor,
    hasOlder: snap.hasOlder,
    loadingOlder: snap.loadingOlder,
    loadOlder,
    refetchNewest,
    fetchDelta,
    setFollowing,
  };
}
