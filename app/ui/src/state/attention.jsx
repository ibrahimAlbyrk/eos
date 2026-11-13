import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { needsAttention as policyNeedsAttention, syncViewed } from "../lib/agentAttention.js";
import { useSettings } from "./settings.jsx";

// Attention state — tracks, per worker, the activity signature the user last
// viewed. Whether the blue dot shows is DERIVED from (state, signature, last
// viewed signature) on every render — see lib/agentAttention.js — so no
// WORKING→IDLE transition can be missed between polls.

const AttentionContext = createContext(null);

export function AttentionProvider({ children }) {
  const { settings } = useSettings();
  // User preference gate. When off, the blue dot and the collapsed-rail blink
  // disappear entirely (the derive returns false). Bookkeeping below keeps
  // running so re-enabling doesn't surface a backlog of "unseen" output.
  const enabled = settings["notifications.sidebarAttention"] !== false;

  // The viewed signatures; `version` gives the readers a new needsAttention
  // only when an update can change what they show (see syncViewed).
  const viewedRef = useRef(new Map());
  const [version, setVersion] = useState(0);

  // One pass per workers update (syncViewed).
  //
  // Dispatch only on a real change. A no-op functional update is "eagerly
  // bailed out" by React but still stays queued until this provider re-renders,
  // which it almost never does — so every workers poll pinned a full workers
  // array and the renderer ran out of memory after a few hours.
  const syncWorkers = useCallback((workers, selectedId) => {
    const { next, visible } = syncViewed(viewedRef.current, workers, selectedId);
    if (!next) return;
    viewedRef.current = next;
    if (visible) setVersion((v) => v + 1);
  }, []);

  // Un-gated by the sidebar-attention setting: the same "stopped with unseen
  // output" policy, for consumers with their own enable switch (split panes).
  // Bookkeeping (syncWorkers) runs regardless of any setting, so the viewed
  // signatures are always current here.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new identity per visible change
  const needsAttentionRaw = useCallback((worker) => {
    if (!worker || !worker.id) return false;
    return policyNeedsAttention(viewedRef.current.get(worker.id), worker);
  }, [version]);

  const needsAttention = useCallback((worker) => {
    if (!enabled) return false;
    return needsAttentionRaw(worker);
  }, [enabled, needsAttentionRaw]);

  // Panel-level signal: OR of every agent's attention. Drives the collapsed
  // sidebar's expand-button pip ("any dot you'd see if the panel were open").
  const anyNeedsAttention = useCallback(
    (workers) => enabled && workers.some((w) => needsAttention(w)),
    [enabled, needsAttention],
  );

  const value = useMemo(() => ({
    needsAttention, needsAttentionRaw, syncWorkers, anyNeedsAttention,
  }), [needsAttention, needsAttentionRaw, syncWorkers, anyNeedsAttention]);

  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}

export function useAttention() {
  const c = useContext(AttentionContext);
  if (!c) throw new Error("useAttention outside AttentionProvider");
  return c;
}

// Single bookkeeping point — called once at the app shell so attention
// tracking keeps running no matter which view is active.
export function useAttentionSync(workers, selectedId) {
  const { syncWorkers } = useAttention();
  useEffect(() => {
    if (workers.length === 0) return;
    syncWorkers(workers, selectedId);
  }, [workers, selectedId, syncWorkers]);
}
