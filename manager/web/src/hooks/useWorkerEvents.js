// useWorkerEvents — event window for the selected agent, with backward
// pagination. Newest-page fetches MERGE into the loaded set (id-keyed) instead
// of replacing it, so history loaded via loadOlder survives poll/SSE refetches.
// Without this, every refetch would shrink the view back to the newest page
// and the top of long transcripts would be unreachable (the original bug).
//
// Ownership invariant: every window write goes through windowReducer and
// carries the workerId its rows were fetched for — rows can only merge into a
// window owned by the same agent, so one agent's transcript can never bleed
// into another's (the cross-agent thinking-leak class of bug).

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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

// The server already filters by worker_id; this client-side boundary turns a
// regression anywhere in that chain into a dropped row plus a console warning
// instead of a silent cross-agent transcript leak.
export function filterOwnRows(workerId, rows) {
  const own = rows.filter((r) => r.worker_id === workerId);
  if (own.length !== rows.length) {
    console.warn(`[useWorkerEvents] dropped ${rows.length - own.length} foreign event row(s) fetched for ${workerId}`);
  }
  return own;
}

// All window writes funnel through here; an action whose workerId doesn't
// match the window's owner can only replace ("newest") or no-op — never mix.
// hasOlder is decided by the FIRST page for a worker and by loadOlder results
// only — newest refetches always return a full page on long transcripts and
// must not resurrect an exhausted cursor.
export function windowReducer(state, action) {
  const { type, workerId, rows } = action;
  switch (type) {
    case "reset":
      return { for: workerId ?? null, events: [], hasOlder: false };
    case "newest":
      return state.for === workerId
        ? { ...state, events: mergeEvents(state.events, rows) }
        : { for: workerId, events: mergeEvents([], rows), hasOlder: rows.length === PAGE_SIZE };
    case "delta":
      return state.for === workerId
        ? { ...state, events: mergeEvents(state.events, rows) }
        : state;
    case "older":
      return state.for === workerId
        ? { ...state, events: mergeEvents(state.events, rows), hasOlder: rows.length === PAGE_SIZE }
        : state;
    default:
      return state;
  }
}

const INITIAL_WINDOW = { for: null, events: [], hasOlder: false };

export function useWorkerEvents(workerId, { restartKey, onNewest } = {}) {
  const [state, dispatch] = useReducer(windowReducer, INITIAL_WINDOW);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadingOlderRef = useRef(false);
  const onNewestRef = useRef(onNewest);
  onNewestRef.current = onNewest;
  const fetchRef = useRef(null);

  useEffect(() => {
    if (!workerId) {
      dispatch({ type: "reset" });
      fetchRef.current = null;
      return;
    }
    const ac = new AbortController();
    let cancelled = false;
    const fetchNewest = async () => {
      try {
        const rows = await api.getWorkerEvents(workerId, { limit: PAGE_SIZE, order: "desc", signal: ac.signal });
        if (cancelled) return;
        if (!Array.isArray(rows)) {
          // A non-array body is an error, not a no-op: leaving the previous
          // window in place would keep another agent's transcript renderable
          // under this selection until a poll finally succeeds.
          dispatch({ type: "reset", workerId });
          return;
        }
        const own = filterOwnRows(workerId, rows);
        dispatch({ type: "newest", workerId, rows: own });
        onNewestRef.current?.(workerId, own);
      } catch (e) {
        if (e?.name === "AbortError" || cancelled) return;
        dispatch({ type: "reset", workerId });
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
  // a missed delta is healed by the poll's newest-page merge. No abort signal
  // on purpose: the api client's in-flight dedup coalesces SSE bursts, and a
  // late response for a switched-away agent is a reducer no-op.
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
      const own = filterOwnRows(workerId, rows);
      dispatch({ type: "delta", workerId, rows: own });
      onNewestRef.current?.(workerId, own);
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
      dispatch({ type: "older", workerId, rows: filterOwnRows(workerId, rows) });
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
