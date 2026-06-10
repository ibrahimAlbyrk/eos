// useWorkerEvents — event window for the selected agent, with backward
// pagination. Newest-page fetches MERGE into the loaded set (id-keyed) instead
// of replacing it, so history loaded via loadOlder survives poll/SSE refetches.
// Without this, every refetch would shrink the view back to the newest page
// and the top of long transcripts would be unreachable (the original bug).

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

const POLL_MS = 5000;
const PAGE_SIZE = 500;

// Union by id; incoming rows win (payloads get patched in place server-side,
// e.g. usage delta-cost back-fill). Sorted by (ts, id) — id is the same-ms
// insertion-order tiebreaker the tool-lifecycle barriers depend on.
export function mergeEvents(current, incoming) {
  if (current.length === 0) return [...incoming];
  if (incoming.length === 0) return current;
  const byId = new Map();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
}

export function useWorkerEvents(workerId, { restartKey, onNewest } = {}) {
  // Single state object: events + which worker they belong to + whether an
  // older page may exist. hasOlder is decided by the FIRST page for a worker
  // and by loadOlder results only — newest refetches always return a full
  // page on long transcripts and must not resurrect an exhausted cursor.
  const [state, setState] = useState({ for: null, events: [], hasOlder: false });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadingOlderRef = useRef(false);
  const onNewestRef = useRef(onNewest);
  onNewestRef.current = onNewest;
  const fetchRef = useRef(null);

  useEffect(() => {
    if (!workerId) {
      setState({ for: null, events: [], hasOlder: false });
      fetchRef.current = null;
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    const fetchNewest = async () => {
      try {
        const rows = await api.getWorkerEvents(workerId, { limit: PAGE_SIZE, order: "desc", signal: ac.signal });
        if (cancelled || !Array.isArray(rows)) return;
        setState((s) => s.for === workerId
          ? { ...s, events: mergeEvents(s.events, rows) }
          : { for: workerId, events: mergeEvents([], rows), hasOlder: rows.length === PAGE_SIZE });
        onNewestRef.current?.(workerId, rows);
      } catch (e) {
        if (e?.name === "AbortError" || cancelled) return;
        setState({ for: workerId, events: [], hasOlder: false });
      }
    };
    fetchRef.current = fetchNewest;
    fetchNewest();
    const t = setInterval(fetchNewest, POLL_MS);
    return () => { cancelled = true; clearInterval(t); ac.abort(); fetchRef.current = null; };
  }, [workerId, restartKey]);

  const refetchNewest = useCallback(() => { fetchRef.current?.(); }, []);

  // SSE fast path: pull only the rows appended after the highest loaded id.
  // Falls back to the newest-page fetch until a first page exists. Best-effort —
  // a missed delta is healed by the poll's newest-page merge.
  const fetchDelta = useCallback(async () => {
    const s = stateRef.current;
    if (!workerId || s.for !== workerId || s.events.length === 0) {
      fetchRef.current?.();
      return;
    }
    let maxId = 0;
    for (const e of s.events) if (e.id > maxId) maxId = e.id;
    try {
      const rows = await api.getWorkerEvents(workerId, { afterId: maxId, limit: PAGE_SIZE });
      if (!Array.isArray(rows) || rows.length === 0) return;
      setState((cur) => cur.for !== workerId ? cur : { ...cur, events: mergeEvents(cur.events, rows) });
      onNewestRef.current?.(workerId, rows);
    } catch { /* transient; poll heals */ }
  }, [workerId]);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (!workerId || s.for !== workerId || !s.hasOlder || loadingOlderRef.current) return;
    const oldestId = s.events[0]?.id;
    if (oldestId == null) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const rows = await api.getWorkerEvents(workerId, { limit: PAGE_SIZE, order: "desc", beforeId: oldestId });
      if (!Array.isArray(rows)) return;
      setState((cur) => cur.for !== workerId ? cur : {
        ...cur,
        events: mergeEvents(cur.events, rows),
        hasOlder: rows.length === PAGE_SIZE,
      });
    } catch {
      // transient; sentinel re-triggers on next intersection
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [workerId]);

  return {
    events: state.events,
    eventsFor: state.for,
    hasOlder: state.hasOlder,
    loadingOlder,
    loadOlder,
    refetchNewest,
    fetchDelta,
  };
}
