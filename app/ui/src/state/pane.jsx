import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSelection } from "./selection.jsx";
import {
  MAX_PANES, FANOUT_MAX, leaf, leaves, leafCount, findLeaf, leafOfAgent, isValidTree,
  splitLeaf, removeLeaf, setRatio, setLeafAgent, removeDeadLeaves, fillAgents,
  fanoutLayout, reuseLeafIds,
} from "../lib/paneLayout.js";
import { followAnchorId, selectFollowChildren } from "../lib/followPolicy.js";

// Split-view layout as a BSP tree (lib/paneLayout): leaves are panes (one agent
// each), splits divide a region in two. The provider owns the tree + the focused
// leaf and exposes a DERIVED flat view (paneAgents/paneCount/focusedPane) so the
// rest of the app stays unaware of the tree. The FOCUSED leaf's agent mirrors the
// global selectedId — that single mirror is why every existing selection path
// (sidebar click, Cmd+1..9, breadcrumb, spawn, native nav) drives the focused
// pane without knowing panes exist.

export { MAX_PANES };

const PaneContext = createContext(null);

function loadTree() {
  try {
    const t = JSON.parse(localStorage.getItem("cm:paneTree") ?? "null");
    if (isValidTree(t)) return t;
  } catch {
    // fall through to a single pane
  }
  return leaf(localStorage.getItem("cm:selectedId"));
}

function loadFocusedLeaf(tree) {
  const id = localStorage.getItem("cm:paneFocusedLeaf");
  return id && findLeaf(tree, id) ? id : leaves(tree)[0].id;
}

export function PaneProvider({ children }) {
  const { selectedId, setSelectedId } = useSelection();
  const [tree, setTree] = useState(loadTree);
  const [focusedLeafId, setFocusedLeafId] = useState(() => loadFocusedLeaf(loadTree()));

  // Synchronous mirrors so the imperative actions read the live value without an
  // impure functional updater — same pattern selection.jsx uses.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const focusedRef = useRef(focusedLeafId);
  focusedRef.current = focusedLeafId;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  // "Follow" mode: a STICKY toggle (persisted). While ON, reconcileFollow owns
  // the tree. It's ACTIVE — orchestrator left, its children tiled right via
  // fanoutLayout — whenever the selection resolves to an orchestrator; otherwise
  // it's DORMANT (shows the selected agent alone) but STAYS ON, so re-selecting
  // an orchestrator auto-opens the fanout again. Only the toggle turns it off.
  const [followMode, setFollowMode] = useState(() => localStorage.getItem("cm:followMode") === "1");
  const followRef = useRef(followMode);
  followRef.current = followMode;
  useEffect(() => { localStorage.setItem("cm:followMode", followMode ? "1" : "0"); }, [followMode]);

  const leafList = useMemo(() => leaves(tree), [tree]);
  const paneAgents = useMemo(() => leafList.map((l) => l.agentId), [leafList]);
  const paneCount = leafList.length;
  const focusedPane = Math.max(0, leafList.findIndex((l) => l.id === focusedLeafId));

  useEffect(() => { localStorage.setItem("cm:paneTree", JSON.stringify(tree)); }, [tree]);
  useEffect(() => { localStorage.setItem("cm:paneFocusedLeaf", focusedLeafId); }, [focusedLeafId]);

  // The focused leaf's agent mirrors the global selection. Guarded (setLeafAgent
  // returns the same tree when unchanged) so the no-op write after a focus/select
  // action can't loop. Skipped in follow-mode — there reconcileFollow owns leaf
  // agents and selection only moves focus.
  useEffect(() => {
    if (followRef.current) return;
    setTree((t) => setLeafAgent(t, focusedLeafId, selectedId));
  }, [selectedId, focusedLeafId]);

  const focusLeaf = useCallback((id) => {
    const l = findLeaf(treeRef.current, id);
    if (!l) return;
    setFocusedLeafId(id);
    setSelectedId(l.agentId ?? null);
  }, [setSelectedId]);

  const focusLeafByIndex = useCallback((i) => {
    const l = leaves(treeRef.current)[i];
    if (l) focusLeaf(l.id);
  }, [focusLeaf]);

  // Any manual layout edit drops out of follow-mode so the auto-reconciler and
  // the user never fight over the tree. Re-enter via the header toggle.
  const exitFollow = useCallback(() => { setFollowMode((v) => (v ? false : v)); }, []);

  // Drop an agent onto a pane edge → split that leaf, new pane on `side`.
  const splitWithAgent = useCallback((leafId, dir, side, agentId) => {
    exitFollow();
    const { tree: next, newId } = splitLeaf(treeRef.current, leafId, dir, side, agentId);
    if (!newId) return;
    setTree(next);
    setFocusedLeafId(newId);
    setSelectedId(agentId ?? null);
  }, [exitFollow, setSelectedId]);

  // "Open empty split" (header button + Cmd+Ctrl+T) — split the focused pane into
  // a fresh empty pane (no agent). The new pane surfaces the hover agent picker.
  const openEmptySplit = useCallback(() => {
    if (leafCount(treeRef.current) >= MAX_PANES) return;
    splitWithAgent(focusedRef.current, "row", "after", null);
  }, [splitWithAgent]);

  // Drop onto a pane center → replace its agent.
  const dropReplace = useCallback((leafId, agentId) => {
    exitFollow();
    setTree((t) => setLeafAgent(t, leafId, agentId));
    setFocusedLeafId(leafId);
    setSelectedId(agentId ?? null);
  }, [exitFollow, setSelectedId]);

  const closeLeaf = useCallback((id) => {
    if (leafCount(treeRef.current) <= 1) return;
    exitFollow();
    const next = removeLeaf(treeRef.current, id);
    setTree(next);
    if (focusedRef.current === id) {
      const fb = leaves(next)[0];
      setFocusedLeafId(fb.id);
      setSelectedId(fb.agentId ?? null);
    }
  }, [exitFollow, setSelectedId]);

  const setRatioFor = useCallback((splitId, ratio) => {
    setTree((t) => setRatio(t, splitId, ratio));
  }, []);

  // Pick an agent from the list (sidebar click, Cmd+1..9). If it's already shown
  // in a different pane, focus that pane instead of duplicating it; otherwise the
  // mirror writes it into the focused pane.
  const selectAgent = useCallback((id) => {
    if (id != null) {
      const l = leafOfAgent(treeRef.current, id);
      if (l && l.id !== focusedRef.current) { focusLeaf(l.id); return; }
    }
    setSelectedId(id);
  }, [focusLeaf, setSelectedId]);

  // Cmd-click toggles an agent as a pane: remove it if shown (never the last),
  // else split the focused pane to add it (capped in splitLeaf).
  const togglePaneForAgent = useCallback((id) => {
    if (!id) return;
    const l = leafOfAgent(treeRef.current, id);
    if (l) {
      if (leafCount(treeRef.current) > 1) closeLeaf(l.id);
      return;
    }
    splitWithAgent(focusedRef.current, "row", "after", id);
  }, [closeLeaf, splitWithAgent]);

  // A killed agent's pane is removed (split collapses to the sibling), not left
  // empty. If the focused pane was the one removed, focus the nearest survivor.
  // The last pane can't be removed → it's emptied instead. Called with the live
  // worker set on every change.
  const prunePanes = useCallback((isAlive) => {
    const cur = treeRef.current;
    const next = removeDeadLeaves(cur, isAlive);
    if (next === cur) return;
    const prevIdx = leaves(cur).findIndex((l) => l.id === focusedRef.current);
    setTree(next);
    if (!findLeaf(next, focusedRef.current)) {
      const list = leaves(next);
      const fb = list[Math.min(Math.max(prevIdx, 0), list.length - 1)] ?? list[0];
      setFocusedLeafId(fb.id);
      setSelectedId(fb.agentId ?? null);
    }
  }, [setSelectedId]);

  // Last agent gone → clean new-session state (no selection, one empty pane),
  // whatever the current layout was. No-op when already a single empty pane, so
  // a repeat tick can't churn it.
  const resetToEmpty = useCallback(() => {
    const ls = leaves(treeRef.current);
    if (!(ls.length === 1 && ls[0].agentId == null)) {
      const fresh = leaf(null);
      setTree(fresh);
      setFocusedLeafId(fresh.id);
    }
    setSelectedId(null);
  }, [setSelectedId]);

  // Apply a complete layout (with agents) as-is — e.g. "Open children".
  const setLayout = useCallback((nextTree) => {
    if (!isValidTree(nextTree)) return;
    exitFollow();
    setTree(nextTree);
    const fb = leaves(nextTree)[0];
    setFocusedLeafId(fb.id);
    setSelectedId(fb.agentId ?? null);
  }, [exitFollow, setSelectedId]);

  // Apply a structure-only layout (a saved preset): re-home the CURRENT agents
  // into its leaves in order — extra agents close, extra leaves open empty. Keeps
  // focus on the same agent if it survived.
  const applyStructure = useCallback((structureTree) => {
    if (!isValidTree(structureTree)) return;
    exitFollow();
    const cur = treeRef.current;
    const prevAgent = findLeaf(cur, focusedRef.current)?.agentId ?? null;
    const next = fillAgents(structureTree, leaves(cur).map((l) => l.agentId));
    setTree(next);
    const fb = leaves(next).find((l) => l.agentId === prevAgent) ?? leaves(next)[0];
    setFocusedLeafId(fb.id);
    setSelectedId(fb.agentId ?? null);
  }, [exitFollow, setSelectedId]);

  // Follow-mode reconcile — recompute the managed layout from the active
  // orchestrator + live workers and apply it. Idempotent: when the desired child
  // set/order is unchanged it does NOT setTree (so the frequent SSE refetch can't
  // churn/remount panes); it only nudges focus to the selected agent's pane.
  // reuseLeafIds keeps surviving children mounted (keep-alive) across set changes.
  const reconcileFollow = useCallback((workers) => {
    const sel = selectedRef.current;

    // DORMANT: follow stays ON but the selection has no orchestrator to fan out
    // (it's not an orchestrator and not an orchestrator's direct child) → show it
    // alone. Idempotent so a background worker tick can't churn the single pane.
    const goDormant = (agent) => {
      const cur = treeRef.current;
      const only = leaves(cur);
      if (only.length === 1 && only[0].agentId === (agent ?? null)) {
        if (only[0].id !== focusedRef.current) setFocusedLeafId(only[0].id);
        return;
      }
      const single = leaf(agent ?? null);
      setTree(single);
      setFocusedLeafId(single.id);
    };

    const byId = new Map(workers.map((w) => [w.id, w]));
    const anchorId = followAnchorId(workers, sel);
    if (!anchorId) {
      // A selected child that was just killed (sel set but gone) → reselect the
      // orchestrator still tiled, don't collapse the fanout onto a dead pane.
      // sel === null is a deliberate new session (Cmd+T / +): fall through to a
      // single empty pane and STAY in follow, so reselecting an orchestrator
      // re-opens its fanout (no need to re-toggle follow).
      if (sel && !byId.has(sel)) {
        const orchLeaf = leaves(treeRef.current).find((l) => byId.get(l.agentId)?.is_orchestrator);
        if (orchLeaf) { setSelectedId(orchLeaf.agentId); return; }
      }
      goDormant(sel);
      return;
    }

    const cur = treeRef.current;
    const curChildren = leaves(cur)
      .map((l) => l.agentId)
      .filter((id) => id != null && id !== anchorId);
    // Pin the selected child so a background spawn can't evict the pane you're in.
    const desired = selectFollowChildren(workers, anchorId, curChildren, FANOUT_MAX - 1, sel);
    // A direct child that's no longer eligible (closed) isn't tiled → show it alone.
    if (sel !== anchorId && !desired.includes(sel)) { goDormant(sel); return; }

    // ACTIVE fanout. Idempotent: unchanged child set/order → no rebuild, just keep
    // focus on the selected pane (so frequent SSE refetches don't remount panes).
    const sameSet = desired.length === curChildren.length
      && desired.every((id, i) => id === curChildren[i]);
    if (sameSet && leafOfAgent(cur, anchorId)) {
      const want = leafOfAgent(cur, sel) ?? leafOfAgent(cur, anchorId);
      if (want && want.id !== focusedRef.current) setFocusedLeafId(want.id);
      return;
    }
    const next = reuseLeafIds(fanoutLayout(anchorId, desired), cur);
    setTree(next);
    const focusOn = leafOfAgent(next, sel) ?? leafOfAgent(next, anchorId) ?? leaves(next)[0];
    setFocusedLeafId(focusOn.id);
  }, [setSelectedId]);

  const toggleFollow = useCallback(() => setFollowMode((v) => !v), []);
  const setFollow = useCallback((on) => setFollowMode(!!on), []);

  const value = useMemo(() => ({
    tree,
    focusedLeafId,
    paneCount,
    paneAgents,
    focusedPane,
    followMode,
    focusLeaf, focusLeafByIndex, splitWithAgent, openEmptySplit, dropReplace, closeLeaf,
    setRatioFor, selectAgent, togglePaneForAgent, prunePanes, resetToEmpty, setLayout, applyStructure,
    reconcileFollow, toggleFollow, setFollow,
  }), [
    tree, focusedLeafId, paneCount, paneAgents, focusedPane, followMode,
    focusLeaf, focusLeafByIndex, splitWithAgent, openEmptySplit, dropReplace, closeLeaf,
    setRatioFor, selectAgent, togglePaneForAgent, prunePanes, resetToEmpty, setLayout, applyStructure,
    reconcileFollow, toggleFollow, setFollow,
  ]);

  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function usePane() {
  const c = useContext(PaneContext);
  if (!c) throw new Error("usePane outside PaneProvider");
  return c;
}
