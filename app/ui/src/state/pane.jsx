import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSelection, EMPTY_PANEL } from "./selection.jsx";
import {
  MAX_PANES, leaf, leaves, leafCount, findLeaf, leafOfAgent, isValidTree,
  splitLeaf, removeLeaf, setRatio, setLeafAgent, removeDeadLeaves,
} from "../lib/paneLayout.js";
import { sessionRootOf } from "../lib/agentIndex.js";
import {
  stashBrowserSession, shouldRestoreBrowser, registerBrowserSessionUi,
} from "./browserSessionState.js";
import { setArchiveViewing } from "./archiveStore.js";

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
  const selection = useSelection();
  const { selectedId, setSelectedId, openPanelIn, panelsByPane } = selection;
  // Live mirrors for the imperative browser-session bridge (reads current
  // selection + per-pane panel state without re-registering).
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const panelsRef = useRef(panelsByPane);
  panelsRef.current = panelsByPane;
  // The focused pane's panel view (open + active tab), for the session-switch
  // stash below; set once focusedLeafId is known (just under the refs).
  const panelViewRef = useRef({ show: false, tab: null });
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
  const focusedPanel = panelsByPane[focusedLeafId] ?? EMPTY_PANEL;
  panelViewRef.current = { show: focusedPanel.open, tab: focusedPanel.activeTab };

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

  // When the focused pane's selection moves to a different session, stash whether
  // the leaving session's Browser tab was showing in that pane, then re-open the
  // arriving session's Browser tab (in the pane the selection landed in) when it
  // was last seen open (or owes its deferred first-use auto-open).
  const prevSelRef = useRef(selectedId);
  useEffect(() => {
    const prev = prevSelRef.current;
    const next = selectedId;
    prevSelRef.current = next;
    if (prev === next) return;
    const { show, tab } = panelViewRef.current;
    stashBrowserSession(sessionRootOf(prev), show && tab === "browser");
    const sessionKey = sessionRootOf(next);
    if (shouldRestoreBrowser(sessionKey)) openPanelIn(focusedRef.current, "browser", { sessionKey });
  }, [selectedId, openPanelIn]);

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
    // Picking a live agent leaves the main-area archive view (the status filter
    // may still show archived rows in the sidebar).
    if (id != null) setArchiveViewing(false);
    if (id != null) {
      const l = leafOfAgent(treeRef.current, id);
      if (l && l.id !== focusedRef.current) { focusLeaf(l.id); return; }
    }
    setSelectedId(id);
  }, [focusLeaf, setSelectedId]);

  // Browser session bridge for the activity rules — per pane now: a session may
  // be shown in several panes, each with its own browser panel. Stable ops +
  // live refs, so it registers once.
  useEffect(() => {
    registerBrowserSessionUi({
      // Real leaf ids whose shown agent belongs to the session.
      panesShowing: (sessionKey) =>
        leaves(treeRef.current)
          .filter((l) => l.agentId && sessionRootOf(l.agentId) === sessionKey)
          .map((l) => l.id),
      isBrowserOpenIn: (paneId) => {
        const p = panelsRef.current[paneId];
        return p?.open === true && p.activeTab === "browser";
      },
      openBrowserIn: (paneId, sessionKey) => openPanelIn(paneId, "browser", { sessionKey }),
      // Select the session's root agent, then bring its Browser tab up in the
      // pane that shows it (else the pane the selection landed in). The presented
      // tab was already set on the session-keyed browserPanelStore by
      // applyActivity before the toast fired.
      openSessionBrowser: (sessionKey) => {
        selectAgent(sessionKey);
        const l = leafOfAgent(treeRef.current, sessionKey);
        openPanelIn(l?.id ?? focusedRef.current, "browser", { sessionKey });
      },
    });
  }, [openPanelIn, selectAgent]);

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
