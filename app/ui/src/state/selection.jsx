import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { pushSelection, takePrevious } from "../lib/selectionHistory.js";
import { topTypeIn, dataIn, openIn, closeIn, popIn, updateDataIn, clearPane, retainPanes } from "../lib/panelMap.js";
import { loadCollapsedNodes, saveCollapsedNodes } from "../lib/collapseMemory.js";

const SelectionContext = createContext(null);

export function SelectionProvider({ children }) {
  const [selectedId, _setSelectedId] = useState(() => localStorage.getItem("cm:selectedId"));
  // Mirrors selectedId synchronously so setSelectedId can read the id it's
  // leaving without an impure functional updater. History is the most-recent-
  // last stack of prior selections (see lib/selectionHistory.js).
  const selectedIdRef = useRef(selectedId);
  const historyRef = useRef([]);
  const setSelectedId = useCallback((id) => {
    historyRef.current = pushSelection(historyRef.current, selectedIdRef.current, id);
    selectedIdRef.current = id;
    _setSelectedId(id);
    if (id) localStorage.setItem("cm:selectedId", id);
    else localStorage.removeItem("cm:selectedId");
  }, []);
  // Pop the most-recent prior selection that still satisfies `exists`. Agent
  // deletion uses this to re-select the agent shown before the deleted one.
  const takePreviousSelection = useCallback((exists) => {
    const { id, history } = takePrevious(historyRef.current, exists, selectedIdRef.current);
    historyRef.current = history;
    return id;
  }, []);
  const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem("cm:sideCollapsed") === "1");

  useEffect(() => { localStorage.setItem("cm:sideCollapsed", sideCollapsed ? "1" : "0"); }, [sideCollapsed]);
  const [openPopover, setOpenPopover] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverData, setPopoverData] = useState({});
  const [collapsedNodes, setCollapsedNodes] = useState(() => loadCollapsedNodes());
  useEffect(() => { saveCollapsedNodes(collapsedNodes); }, [collapsedNodes]);
  const [expandedTools, setExpandedTools] = useState(() => new Set());
  // Right-panel navigation stacks, now keyed by paneId: { [leafId]: stack }
  // (see lib/panelMap, which reuses lib/panelStack per pane). Each viewer is
  // owned by its originating pane and docks to that pane's right edge. The
  // pane-aware reads/wrappers live in useUi (it knows the originating pane via
  // PaneScopeContext); this provider owns the map + the raw paneId-explicit ops.
  // A buried entry stays MOUNTED so its fetched data/expand state survive a
  // viewer pushed on top, exactly as the single global stack did before.
  const [panelsByPane, setPanelsByPane] = useState({});
  const panelsRef = useRef(panelsByPane);
  panelsRef.current = panelsByPane;
  const topPanelTypeIn = useCallback((paneId) => topTypeIn(panelsRef.current, paneId), []);
  const panelDataIn = useCallback((paneId, type) => dataIn(panelsRef.current, paneId, type), []);
  const openPanelIn = useCallback((paneId, type, data) => setPanelsByPane((m) => openIn(m, paneId, type, data)), []);
  const closePanelIn = useCallback((paneId, type) => setPanelsByPane((m) => closeIn(m, paneId, type)), []);
  const popPanelIn = useCallback((paneId) => setPanelsByPane((m) => popIn(m, paneId)), []);
  const updatePanelDataIn = useCallback((paneId, type, updater) => setPanelsByPane((m) => updateDataIn(m, paneId, type, updater)), []);
  // Clear-on-rebuild hooks, driven by PaneProvider (which owns the tree).
  const clearPanelsIn = useCallback((paneId) => setPanelsByPane((m) => clearPane(m, paneId)), []);
  const retainPanelsFor = useCallback((liveIds) => setPanelsByPane((m) => retainPanes(m, liveIds)), []);
  // Escape pops the FOCUSED pane's stack. The keydown lives here but this
  // provider can't see pane focus, so PaneProvider registers a focus-aware
  // popper (mirrors registerEscapeGitMode). Returns true when it consumed Esc.
  const escapePanelRef = useRef(null);
  const registerEscapePanel = useCallback((fn) => { escapePanelRef.current = fn; }, []);
  const [renamingId, setRenamingId] = useState(null);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  // {workerId, verdict, command, ts} — derived by Messages from the loaded
  // event window (same publish pattern as pendingQuestion); read by the
  // diff row / diff viewer verdict chips. Advisory only.
  const [verdict, setVerdict] = useState(null);
  const [dismissedQuestions, setDismissedQuestions] = useState(() => new Set());
  const dismissQuestion = useCallback((toolUseId) => {
    setDismissedQuestions((prev) => new Set(prev).add(toolUseId));
  }, []);
  // {workerId} while the rewind panel is open (double-Esc, like Claude Code).
  const [rewindPanel, setRewindPanel] = useState(null);
  const openRewindPanel = useCallback((workerId) => setRewindPanel({ workerId }), []);
  const closeRewindPanel = useCallback(() => setRewindPanel(null), []);
  const lastEscTsRef = useRef(0);
  const escapeIdleRef = useRef(null);
  const registerEscapeIdle = useCallback((fn) => { escapeIdleRef.current = fn; }, []);
  // Composer registers a handler that exits git mode; returns true when it
  // consumed the Escape (ComposerProvider lives below this provider, so the
  // state itself isn't readable here).
  const escapeGitModeRef = useRef(null);
  const registerEscapeGitMode = useCallback((fn) => { escapeGitModeRef.current = fn; }, []);

  const openPop = useCallback((id, opts = {}) => {
    setOpenPopover(id);
    if (opts.x != null && opts.y != null) setPopoverPos({ x: opts.x, y: opts.y });
    if (opts.data) setPopoverData(opts.data);
  }, []);
  const closeAllPops = useCallback(() => {
    setOpenPopover(null);
    setPopoverData({});
  }, []);

  // (Clear-on-select is now per pane: PaneProvider clears a pane's stack when
  // that pane's shown agent changes — see pane.jsx — preserving single-pane
  // parity without nuking another pane's panel on a focus move.)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // consumed inside the editor (e.g. closing the autocomplete popup)
      if (e.defaultPrevented) return;
      // preventDefault on every handled Escape: an unconsumed Esc reaches the
      // WKWebView's native responder chain → NSWindow cancelOperation: → exits
      // macOS fullscreen. Closing a panel must not also drop fullscreen.
      if (rewindPanel) { e.preventDefault(); setRewindPanel(null); return; }
      if (openPopover) { e.preventDefault(); closeAllPops(); return; }
      if (escapePanelRef.current?.()) { e.preventDefault(); return; }
      if (escapeGitModeRef.current?.()) { e.preventDefault(); return; }
      // Double-Esc with an agent selected → rewind panel (Claude Code parity:
      // composer's own double-Esc-clears-text path preventDefaults, so this
      // only fires when the input was already empty).
      const now = Date.now();
      const isDouble = now - lastEscTsRef.current <= 500;
      lastEscTsRef.current = now;
      if (isDouble && selectedId) {
        e.preventDefault();
        setRewindPanel({ workerId: selectedId });
        return;
      }
      if (escapeIdleRef.current) { e.preventDefault(); escapeIdleRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAllPops, openPopover, rewindPanel, selectedId]);

  const toggleNodeCollapsed = useCallback((id) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const removeCollapsedNodes = useCallback((ids) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) if (next.delete(id)) changed = true;
      return changed ? next : prev;
    });
  }, []);

  const toggleToolExpanded = useCallback((id) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Toggles are XOR overrides against the settings-driven default (see
  // settings/toolExpansion.js). When a verbose.* setting changes, stale
  // toggles would invert the new default — so settings.jsx drops them all.
  const resetToolToggles = useCallback(() => setExpandedTools(new Set()), []);

  const value = useMemo(() => ({
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, setSideCollapsed,
    openPopover, openPop, closeAllPops, popoverPos, popoverData,
    collapsedNodes, toggleNodeCollapsed, removeCollapsedNodes,
    expandedTools, toggleToolExpanded, resetToolToggles,
    renamingId, setRenamingId,
    pendingQuestion, setPendingQuestion, dismissedQuestions, dismissQuestion,
    verdict, setVerdict,
    // Raw paneId-explicit panel ops + reads. useUi wraps these into the
    // scope-aware openFileViewer/topPanelType/... that every consumer calls.
    topPanelTypeIn, panelDataIn,
    openPanelIn, closePanelIn, popPanelIn, updatePanelDataIn,
    clearPanelsIn, retainPanelsFor, registerEscapePanel,
    rewindPanel, openRewindPanel, closeRewindPanel,
    registerEscapeIdle,
    registerEscapeGitMode,
  }), [
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, openPopover, popoverPos, popoverData,
    collapsedNodes, expandedTools, renamingId, pendingQuestion, dismissedQuestions, verdict, panelsByPane,
    rewindPanel, openRewindPanel, closeRewindPanel,
    openPop, closeAllPops, toggleNodeCollapsed, removeCollapsedNodes, toggleToolExpanded, resetToolToggles,
    topPanelTypeIn, panelDataIn,
    openPanelIn, closePanelIn, popPanelIn, updatePanelDataIn,
    clearPanelsIn, retainPanelsFor, registerEscapePanel,
    registerEscapeIdle,
    registerEscapeGitMode,
  ]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection() {
  const c = useContext(SelectionContext);
  if (!c) throw new Error("useSelection outside SelectionProvider");
  return c;
}
