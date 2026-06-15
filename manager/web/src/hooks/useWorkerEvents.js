// useWorkerEvents — thin adapter over state/eventsStore.js. The window cache,
// pagination, polling and read-ahead prefetch all live in the store (module
// scope), so a loaded transcript survives unmounts and agent switches; this
// hook only subscribes the component to its agent's snapshot.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  attach, fetchDelta as storeFetchDelta, getSnapshot, loadOlder as storeLoadOlder,
  refetchNewest as storeRefetchNewest, setFollowing as storeSetFollowing, subscribe,
} from "../state/eventsStore.js";

const noopSubscribe = () => () => {};

export function useWorkerEvents(workerId, { restartKey, onNewest } = {}) {
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
    return attach(workerId, { onNewest: (id, rows) => onNewestRef.current?.(id, rows) });
  }, [workerId]);

  // restartKey (workers-list shape) → immediate newest refetch. attach()
  // already fetched on mount, so the first run is skipped.
  const restartSeen = useRef(false);
  useEffect(() => {
    if (!restartSeen.current) {
      restartSeen.current = true;
      return;
    }
    if (workerId) storeRefetchNewest(workerId);
  }, [restartKey]);

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
