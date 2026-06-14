import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSelection } from "./selection.jsx";
import {
  MAX_PANES, clampCount, resizePanes, focusAfterResize,
  removePane, focusAfterRemove, pruneDeadPanes,
} from "../lib/paneModel.js";

// Split-view pane model. The center can show up to MAX_PANES agent transcripts
// side by side. paneAgents[i] is the agent id shown in pane i (null = empty);
// its length IS the pane count. The FOCUSED pane always mirrors the global
// selectedId (selection.jsx) — that single mirror is why every existing
// selection call site (sidebar click, Cmd+1..9, breadcrumb, spawn, native nav)
// drives the focused pane without knowing panes exist. Header, composer and the
// right panel follow selectedId, so they follow the focused pane for free.
//
// All list/focus transforms are the pure, unit-tested helpers in lib/paneModel.

export { MAX_PANES };

const PaneContext = createContext(null);

function loadAgents() {
  try {
    const arr = JSON.parse(localStorage.getItem("cm:paneAgents") ?? "null");
    if (Array.isArray(arr) && arr.length >= 1 && arr.length <= MAX_PANES) {
      return arr.map((x) => (typeof x === "string" ? x : null));
    }
  } catch {
    // fall through to the single-pane default
  }
  // Single pane mirroring the persisted selection — N=1 is the pre-split
  // behavior, so a fresh user starts exactly as before.
  return [localStorage.getItem("cm:selectedId")];
}

function loadFocused(len) {
  const fi = parseInt(localStorage.getItem("cm:paneFocused") ?? "0", 10);
  return Number.isInteger(fi) && fi >= 0 && fi < len ? fi : 0;
}

export function PaneProvider({ children }) {
  const { selectedId, setSelectedId } = useSelection();
  const [agents, setAgents] = useState(loadAgents);
  const [focusedIndex, setFocusedIndex] = useState(() => loadFocused(loadAgents().length));

  // Synchronous mirrors so the imperative actions can read the live value
  // without an impure functional updater — same pattern selection.jsx uses.
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const focusedRef = useRef(focusedIndex);
  focusedRef.current = focusedIndex;

  const count = agents.length;

  useEffect(() => { localStorage.setItem("cm:paneAgents", JSON.stringify(agents)); }, [agents]);
  useEffect(() => { localStorage.setItem("cm:paneFocused", String(focusedIndex)); }, [focusedIndex]);

  // The focused slot mirrors the global selection. selectedId changes through
  // many existing paths; mirroring here keeps every one of them pane-agnostic.
  // Guarded so the no-op write after focusPane()/setSelectedId() can't loop.
  useEffect(() => {
    setAgents((a) => {
      if (a[focusedIndex] === selectedId) return a;
      const next = a.slice();
      next[focusedIndex] = selectedId;
      return next;
    });
  }, [selectedId, focusedIndex]);

  const focusPane = useCallback((i) => {
    if (i === focusedRef.current) return;
    setFocusedIndex(i);
    setSelectedId(agentsRef.current[i] ?? null);
  }, [setSelectedId]);

  const setPaneCount = useCallback((n) => {
    const next = clampCount(n);
    const oldLen = agentsRef.current.length;
    if (next === oldLen) return;
    const resized = resizePanes(agentsRef.current, next);
    setAgents(resized);
    const fi = focusAfterResize(focusedRef.current, oldLen, next);
    if (fi !== focusedRef.current) {
      setFocusedIndex(fi);
      // Grow focuses the new empty pane (selection clears → the next sidebar
      // pick lands here, not over the pane you were already viewing).
      setSelectedId(resized[fi] ?? null);
    }
  }, [setSelectedId]);

  const closePane = useCallback((i) => {
    if (agentsRef.current.length <= 1) return;
    const next = removePane(agentsRef.current, i);
    setAgents(next);
    const fi = focusAfterRemove(focusedRef.current, i, next.length);
    if (fi !== focusedRef.current || i === focusedRef.current) {
      setFocusedIndex(fi);
      setSelectedId(next[fi] ?? null);
    }
  }, [setSelectedId]);

  // Drop agents that no longer exist from the non-focused panes (the focused
  // slot is owned by selectedId, which CodeView already cleans). Called with the
  // live worker set, which this provider can't see itself.
  const prunePanes = useCallback((isAlive) => {
    setAgents((a) => pruneDeadPanes(a, focusedRef.current, isAlive));
  }, []);

  const value = useMemo(() => ({
    paneCount: count,
    paneAgents: agents,
    focusedPane: Math.min(focusedIndex, count - 1),
    setPaneCount, focusPane, closePane, prunePanes,
  }), [count, agents, focusedIndex, setPaneCount, focusPane, closePane, prunePanes]);

  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function usePane() {
  const c = useContext(PaneContext);
  if (!c) throw new Error("usePane outside PaneProvider");
  return c;
}
