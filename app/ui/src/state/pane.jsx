import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSelection } from "./selection.jsx";
import { isDockFullscreen, setDockFullscreen } from "./dockFullscreenStore.js";
import {
  MAX_PANES, leaf, leaves, leafCount, findLeaf, leafOfAgent, isValidTree,
  splitLeaf, removeLeaf, setRatio, setLeafAgent, removeDeadLeaves,
} from "../lib/paneLayout.js";

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
  const {
    selectedId, setSelectedId,
    topPanelTypeIn, popPanelIn, clearPanelsIn, retainPanelsFor, registerEscapePanel,
  } = useSelection();
  const [tree, setTree] = useState(loadTree);
  const [focusedLeafId, setFocusedLeafId] = useState(() => loadFocusedLeaf(loadTree()));
  // Which region of the focused pane owns region-scoped shortcuts (⌘F): the
  // transcript or its docked panel. Set by mousedown-capture in PaneGrid /
  // SinglePane; any focus change resets to the transcript (the default owner).
  const [focusedRegion, setFocusedRegion] = useState("transcript");

  // Synchronous mirrors so the imperative actions read the live value without an
  // impure functional updater — same pattern selection.jsx uses.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const focusedRef = useRef(focusedLeafId);
  focusedRef.current = focusedLeafId;

  const leafList = useMemo(() => leaves(tree), [tree]);
  const paneAgents = useMemo(() => leafList.map((l) => l.agentId), [leafList]);
  const paneCount = leafList.length;
  const focusedPane = Math.max(0, leafList.findIndex((l) => l.id === focusedLeafId));

  useEffect(() => { localStorage.setItem("cm:paneTree", JSON.stringify(tree)); }, [tree]);
  useEffect(() => { localStorage.setItem("cm:paneFocusedLeaf", focusedLeafId); }, [focusedLeafId]);

  // The focused leaf's agent mirrors the global selection. Guarded (setLeafAgent
  // returns the same tree when unchanged) so the no-op write after a focus/select
  // action can't loop.
  useEffect(() => {
    setTree((t) => setLeafAgent(t, focusedLeafId, selectedId));
  }, [selectedId, focusedLeafId]);

  // Escape pops the FOCUSED pane's panel stack. SelectionProvider owns the
  // keydown but can't see focus, so we register a focus-aware popper (reads live
  // focus + selection's stable ops, so this registers once).
  useEffect(() => {
    registerEscapePanel(() => {
      const id = focusedRef.current;
      if (!id) return false;
      // A fullscreen dock eats the first Esc (exit fullscreen); a second Esc
      // then falls through to the normal panel-close chain below.
      if (isDockFullscreen(id)) { setDockFullscreen(id, false); return true; }
      if (topPanelTypeIn(id)) { popPanelIn(id); return true; }
      return false;
    });
  }, [registerEscapePanel, topPanelTypeIn, popPanelIn]);

  // Clear-on-rebuild: on every tree change, drop any panel whose pane no longer
  // exists. Covers close / prune / preset reapply (fillAgents mints fresh leaf
  // ids → all old-keyed panels orphan and are pruned). No-op when all live.
  const liveLeafIds = useMemo(() => leafList.map((l) => l.id), [leafList]);
  useEffect(() => {
    retainPanelsFor(new Set(liveLeafIds));
  }, [liveLeafIds, retainPanelsFor]);

  // Clear a pane's panel when its shown AGENT changes — single-pane parity with
  // the old global clear-on-select (switching agents drops the stale viewer),
  // without nuking another pane's panel on a focus move. New panes (no prior
  // entry) and removed panes (handled above) are skipped; reuseLeafIds keeps
  // id↔agent stable across follow rebuilds so survivors don't churn.
  const paneAgentsRef = useRef(null);
  useEffect(() => {
    const cur = new Map(leafList.map((l) => [l.id, l.agentId ?? null]));
    const prev = paneAgentsRef.current;
    paneAgentsRef.current = cur;
    if (!prev) return;
    for (const [id, agentId] of cur) {
      if (prev.has(id) && prev.get(id) !== agentId) clearPanelsIn(id);
    }
  }, [leafList, clearPanelsIn]);

  const focusLeaf = useCallback((id) => {
    const l = findLeaf(treeRef.current, id);
    if (!l) return;
    setFocusedLeafId(id);
    setFocusedRegion("transcript");
    setSelectedId(l.agentId ?? null);
  }, [setSelectedId]);

  const focusLeafByIndex = useCallback((i) => {
    const l = leaves(treeRef.current)[i];
    if (l) focusLeaf(l.id);
  }, [focusLeaf]);

  // Drop an agent onto a pane edge → split that leaf, new pane on `side`.
  const splitWithAgent = useCallback((leafId, dir, side, agentId) => {
    const { tree: next, newId } = splitLeaf(treeRef.current, leafId, dir, side, agentId);
    if (!newId) return;
    setTree(next);
    setFocusedLeafId(newId);
    setSelectedId(agentId ?? null);
  }, [setSelectedId]);

  // "Open empty split" (Cmd+Ctrl+T) — split the focused pane into a fresh empty
  // pane (no agent). The new pane surfaces the hover agent picker.
  const openEmptySplit = useCallback(() => {
    if (leafCount(treeRef.current) >= MAX_PANES) return;
    splitWithAgent(focusedRef.current, "row", "after", null);
  }, [splitWithAgent]);

  // Drop onto a pane center → replace its agent.
  const dropReplace = useCallback((leafId, agentId) => {
    setTree((t) => setLeafAgent(t, leafId, agentId));
    setFocusedLeafId(leafId);
    setSelectedId(agentId ?? null);
  }, [setSelectedId]);

  const closeLeaf = useCallback((id) => {
    if (leafCount(treeRef.current) <= 1) return;
    const next = removeLeaf(treeRef.current, id);
    setTree(next);
    if (focusedRef.current === id) {
      const fb = leaves(next)[0];
      setFocusedLeafId(fb.id);
      setSelectedId(fb.agentId ?? null);
    }
  }, [setSelectedId]);

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
    setTree(nextTree);
    const fb = leaves(nextTree)[0];
    setFocusedLeafId(fb.id);
    setSelectedId(fb.agentId ?? null);
  }, [setSelectedId]);

  const value = useMemo(() => ({
    tree,
    focusedLeafId,
    focusedRegion, setFocusedRegion,
    paneCount,
    paneAgents,
    focusedPane,
    focusLeaf, focusLeafByIndex, splitWithAgent, openEmptySplit, dropReplace, closeLeaf,
    setRatioFor, selectAgent, togglePaneForAgent, prunePanes, resetToEmpty, setLayout,
  }), [
    tree, focusedLeafId, focusedRegion, paneCount, paneAgents, focusedPane,
    focusLeaf, focusLeafByIndex, splitWithAgent, openEmptySplit, dropReplace, closeLeaf,
    setRatioFor, selectAgent, togglePaneForAgent, prunePanes, resetToEmpty, setLayout,
  ]);

  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function usePane() {
  const c = useContext(PaneContext);
  if (!c) throw new Error("usePane outside PaneProvider");
  return c;
}
