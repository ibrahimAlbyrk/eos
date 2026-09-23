import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { pushSelection, takePrevious } from "../lib/selectionHistory.js";
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
  // Sidebar collapse is tri-state: 'expanded' | 'collapsed' | 'collapsed-hover'.
  // Only the expanded↔collapsed axis persists; 'collapsed-hover' is a transient
  // pointer state (the floating flyout) that always resolves back to 'collapsed'.
  // A 240ms leave delay lets the pointer cross the gap from the header hamburger
  // to the floating card without it snapping shut. Later phases (the header
  // hamburger + traffic lights, split-pane headers) read `sidebarMode` directly;
  // `sideCollapsed`/`setSideCollapsed` stay as the boolean back-compat shim every
  // current consumer (grid class, rename gate) already uses.
  const [sidebarMode, setSidebarMode] = useState(
    () => (localStorage.getItem("cm:sideCollapsed") === "1" ? "collapsed" : "expanded"),
  );
  useEffect(() => {
    localStorage.setItem("cm:sideCollapsed", sidebarMode === "expanded" ? "0" : "1");
  }, [sidebarMode]);
  const hoverLeaveTimer = useRef(null);
  const collapseSidebar = useCallback(() => { clearTimeout(hoverLeaveTimer.current); setSidebarMode("collapsed"); }, []);
  const expandSidebar = useCallback(() => { clearTimeout(hoverLeaveTimer.current); setSidebarMode("expanded"); }, []);
  const hoverSidebarIn = useCallback(() => {
    clearTimeout(hoverLeaveTimer.current);
    setSidebarMode((m) => (m === "collapsed" ? "collapsed-hover" : m));
  }, []);
  const hoverSidebarKeep = useCallback(() => { clearTimeout(hoverLeaveTimer.current); }, []);
  const hoverSidebarOut = useCallback(() => {
    clearTimeout(hoverLeaveTimer.current);
    hoverLeaveTimer.current = setTimeout(() => {
      // Keep the flyout up while a menu opened from inside it is still open
      // (right-click an agent row → context menu portaled to <body>).
      if (Object.values(openPopByPaneRef.current).some(Boolean)) return;
      setSidebarMode((m) => (m === "collapsed-hover" ? "collapsed" : m));
    }, 240);
  }, []);
  const sideCollapsed = sidebarMode !== "expanded";
  const setSideCollapsed = useCallback((v) => {
    clearTimeout(hoverLeaveTimer.current);
    setSidebarMode(v ? "collapsed" : "expanded");
  }, []);
  // Popover open state is PER PANE, keyed by leaf id: { [paneId]: id }. Each
  // pane owns its own Composer, so opening one pane's menu must not render it in
  // the others (they gated on a single global string before). Chrome outside a
  // pane resolves to the focused pane via useUi's scope. Position/data stay
  // global — only the mutually-exclusive chrome context menus use them.
  const [openPopoverByPane, setOpenPopoverByPane] = useState({});
  const openPopByPaneRef = useRef(openPopoverByPane);
  openPopByPaneRef.current = openPopoverByPane;
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverData, setPopoverData] = useState({});
  const [collapsedNodes, setCollapsedNodes] = useState(() => loadCollapsedNodes());
  useEffect(() => { saveCollapsedNodes(collapsedNodes); }, [collapsedNodes]);
  const [expandedTools, setExpandedTools] = useState(() => new Set());
  // ── Single shared right side panel (replaces the per-pane tiling dock) ──
  // ONE panel for the whole workspace, not per pane: an active tab, an open
  // flag, a width, and per-tab data keyed by tab. `panelFile` is the file open
  // INSIDE the Files tab (nested viewer) — the explorer shows when it's null.
  // Tab + open flag + width persist; per-tab data and the open file are
  // session-only (they derive from the selected agent).
  const [panelTab, setPanelTab] = useState(() => localStorage.getItem("cm:sidePanelTab") || "review");
  const [showSidePanel, setShowSidePanel] = useState(() => localStorage.getItem("cm:showSidePanel") === "1");
  const [sidePanelWidth, _setSidePanelWidth] = useState(() => {
    const v = Number(localStorage.getItem("cm:sidePanelWidth"));
    return Number.isFinite(v) && v > 0 ? v : null;
  });
  const [panelData, setPanelData] = useState({});
  const [panelFile, setPanelFile] = useState(null);
  useEffect(() => { localStorage.setItem("cm:sidePanelTab", panelTab); }, [panelTab]);
  useEffect(() => { localStorage.setItem("cm:showSidePanel", showSidePanel ? "1" : "0"); }, [showSidePanel]);
  useEffect(() => {
    if (sidePanelWidth) localStorage.setItem("cm:sidePanelWidth", String(sidePanelWidth));
    else localStorage.removeItem("cm:sidePanelWidth");
  }, [sidePanelWidth]);
  // Setting a tab always reveals the panel (reference: setTab ⇒ showSidePanel:true).
  const setTab = useCallback((tab) => { setPanelTab(tab); setShowSidePanel(true); }, []);
  const openPanel = useCallback((tab, data) => {
    setPanelTab(tab);
    setShowSidePanel(true);
    if (data) setPanelData((m) => ({ ...m, [tab]: { ...m[tab], ...data } }));
  }, []);
  const closePanel = useCallback(() => setShowSidePanel(false), []);
  const toggleSidePanel = useCallback(() => setShowSidePanel((v) => !v), []);
  const setSidePanelWidth = useCallback((px) => _setSidePanelWidth(px && px > 0 ? Math.round(px) : null), []);
  // Monotonic reveal seq so re-opening the same file+line re-centers the editor.
  const fileRevealSeq = useRef(0);
  const openFile = useCallback((path, reveal) => {
    setPanelTab("files");
    setShowSidePanel(true);
    setPanelFile({ path, reveal: reveal ? { line: reveal.line, column: reveal.column, seq: ++fileRevealSeq.current } : null });
  }, []);
  const closeFile = useCallback(() => setPanelFile(null), []);
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

  // Raw paneId-explicit popover ops. useUi wraps these into the scope-aware
  // openPop/closeAllPops/openPopover that every call site uses (mirrors the
  // panelsByPane pattern) — a composer scopes to its own pane, chrome to focused.
  const openPopoverIn = useCallback((paneId) => openPopByPaneRef.current[paneId] ?? null, []);
  const openPopIn = useCallback((paneId, id, opts = {}) => {
    setOpenPopoverByPane((m) => ({ ...m, [paneId]: id }));
    if (opts.x != null && opts.y != null) setPopoverPos({ x: opts.x, y: opts.y });
    if (opts.data) setPopoverData(opts.data);
  }, []);
  const closePopsIn = useCallback((paneId) => {
    setOpenPopoverByPane((m) => {
      if (!(paneId in m)) return m;
      const next = { ...m };
      delete next[paneId];
      return next;
    });
    setPopoverData({});
  }, []);
  // Close every pane's popover at once — Escape and any global dismissal.
  const closeAllPopsEverywhere = useCallback(() => {
    setOpenPopoverByPane((m) => (Object.keys(m).length ? {} : m));
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
      if (Object.keys(openPopByPaneRef.current).length) { e.preventDefault(); closeAllPopsEverywhere(); return; }
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
  }, [closeAllPopsEverywhere, rewindPanel, selectedId]);

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
    sidebarMode, collapseSidebar, expandSidebar, hoverSidebarIn, hoverSidebarKeep, hoverSidebarOut,
    openPopoverIn, openPopIn, closePopsIn, closeAllPopsEverywhere, popoverPos, popoverData,
    collapsedNodes, toggleNodeCollapsed, removeCollapsedNodes,
    expandedTools, toggleToolExpanded, resetToolToggles,
    renamingId, setRenamingId,
    pendingQuestion, setPendingQuestion, dismissedQuestions, dismissQuestion,
    verdict, setVerdict,
    // Single shared side panel — tab/open/width state + actions. useUi derives
    // the per-tab reads (reviewViewer/filesViewer/...) from panelData + the
    // selected agent.
    panelTab, showSidePanel, sidePanelWidth, panelData, panelFile,
    setTab, openPanel, closePanel, toggleSidePanel, setSidePanelWidth, openFile, closeFile,
    rewindPanel, openRewindPanel, closeRewindPanel,
    registerEscapeIdle,
    registerEscapeGitMode,
  }), [
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, setSideCollapsed, sidebarMode,
    collapseSidebar, expandSidebar, hoverSidebarIn, hoverSidebarKeep, hoverSidebarOut,
    openPopoverByPane, popoverPos, popoverData,
    collapsedNodes, expandedTools, renamingId, pendingQuestion, dismissedQuestions, verdict,
    panelTab, showSidePanel, sidePanelWidth, panelData, panelFile,
    setTab, openPanel, closePanel, toggleSidePanel, setSidePanelWidth, openFile, closeFile,
    rewindPanel, openRewindPanel, closeRewindPanel,
    openPopoverIn, openPopIn, closePopsIn, closeAllPopsEverywhere, toggleNodeCollapsed, removeCollapsedNodes, toggleToolExpanded, resetToolToggles,
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
