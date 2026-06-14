import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSelection } from "./selection.jsx";
import {
  MAX_PANES, leaf, leaves, leafCount, findLeaf, leafOfAgent, isValidTree,
  splitLeaf, removeLeaf, setRatio, setLeafAgent, removeDeadLeaves, fillAgents,
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
  const { selectedId, setSelectedId } = useSelection();
  const [tree, setTree] = useState(loadTree);
  const [focusedLeafId, setFocusedLeafId] = useState(() => loadFocusedLeaf(loadTree()));

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

  // Drop an agent onto a pane edge → split that leaf, new pane on `side`.
  const splitWithAgent = useCallback((leafId, dir, side, agentId) => {
    const { tree: next, newId } = splitLeaf(treeRef.current, leafId, dir, side, agentId);
    if (!newId) return;
    setTree(next);
    setFocusedLeafId(newId);
    setSelectedId(agentId ?? null);
  }, [setSelectedId]);

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

  // Apply a complete layout (with agents) as-is — e.g. "Open children".
  const setLayout = useCallback((nextTree) => {
    if (!isValidTree(nextTree)) return;
    setTree(nextTree);
    const fb = leaves(nextTree)[0];
    setFocusedLeafId(fb.id);
    setSelectedId(fb.agentId ?? null);
  }, [setSelectedId]);

  // Apply a structure-only layout (a saved preset): re-home the CURRENT agents
  // into its leaves in order — extra agents close, extra leaves open empty. Keeps
  // focus on the same agent if it survived.
  const applyStructure = useCallback((structureTree) => {
    if (!isValidTree(structureTree)) return;
    const cur = treeRef.current;
    const prevAgent = findLeaf(cur, focusedRef.current)?.agentId ?? null;
    const next = fillAgents(structureTree, leaves(cur).map((l) => l.agentId));
    setTree(next);
    const fb = leaves(next).find((l) => l.agentId === prevAgent) ?? leaves(next)[0];
    setFocusedLeafId(fb.id);
    setSelectedId(fb.agentId ?? null);
  }, [setSelectedId]);

  const value = useMemo(() => ({
    tree,
    focusedLeafId,
    paneCount,
    paneAgents,
    focusedPane,
    focusLeaf, focusLeafByIndex, splitWithAgent, dropReplace, closeLeaf,
    setRatioFor, selectAgent, togglePaneForAgent, prunePanes, setLayout, applyStructure,
  }), [
    tree, focusedLeafId, paneCount, paneAgents, focusedPane,
    focusLeaf, focusLeafByIndex, splitWithAgent, dropReplace, closeLeaf,
    setRatioFor, selectAgent, togglePaneForAgent, prunePanes, setLayout, applyStructure,
  ]);

  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>;
}

export function usePane() {
  const c = useContext(PaneContext);
  if (!c) throw new Error("usePane outside PaneProvider");
  return c;
}
