import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { needsAttention as policyNeedsAttention, sigOf } from "../lib/agentAttention.js";
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

  const [viewedSigs, setViewedSigs] = useState(() => new Map());

  // Seed unseen workers, keep the selected one in sync, and prune entries
  // for workers that no longer exist — one pass per workers update.
  const syncWorkers = useCallback((workers, selectedId) => {
    setViewedSigs((prev) => {
      let next = null;
      const ids = new Set();
      for (const w of workers) {
        if (!w || !w.id) continue;
        ids.add(w.id);
        const shouldSync = w.id === selectedId || !prev.has(w.id);
        if (!shouldSync) continue;
        const sig = sigOf(w);
        if (prev.get(w.id) === sig) continue;
        next ??= new Map(prev);
        next.set(w.id, sig);
      }
      for (const id of prev.keys()) {
        if (ids.has(id)) continue;
        next ??= new Map(prev);
        next.delete(id);
      }
      return next ?? prev;
    });
  }, []);

  const needsAttention = useCallback((worker) => {
    if (!enabled) return false;
    if (!worker || !worker.id) return false;
    return policyNeedsAttention(viewedSigs.get(worker.id), worker);
  }, [enabled, viewedSigs]);

  // Panel-level signal: OR of every agent's attention. Drives the collapsed
  // sidebar's expand-button pip ("any dot you'd see if the panel were open").
  const anyNeedsAttention = useCallback(
    (workers) => enabled && workers.some((w) => needsAttention(w)),
    [enabled, needsAttention],
  );

  const value = useMemo(() => ({
    needsAttention, syncWorkers, anyNeedsAttention,
  }), [needsAttention, syncWorkers, anyNeedsAttention]);

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
