import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { pushSelection, takePrevious } from "../lib/selectionHistory.js";
import { loadCollapsedNodes, saveCollapsedNodes } from "../lib/collapseMemory.js";
import { openTab as openTabReducer, closeTab as closeTabReducer } from "../lib/panelTabs.js";

const SelectionContext = createContext(null);

// One pane's side-panel: an open flag, an ordered set of open tabs + the active
// one, a width, a fullscreen flag, per-tab data, and the file open inside the
// Files tab. Frozen shared default so empty panes resolve to a stable identity.
export const EMPTY_PANEL = Object.freeze({
  open: false, openTabs: [], activeTab: null, width: null, fullscreen: false, data: {}, file: null,
});

// Per-pane panels persist keyed by leaf id (the pane tree persists the same
// ids), storing only the durable bits — open / tabs / width. A pane with no
// stored entry resolves to EMPTY_PANEL, so a fresh session starts with no tabs.
function loadPanels() {
  try {
    const raw = JSON.parse(localStorage.getItem("cm:sidePanels") ?? "null");
    if (raw && typeof raw === "object") {
      const out = {};
      for (const [id, v] of Object.entries(raw)) {
        if (!v || !Array.isArray(v.openTabs)) continue;
        const openTabs = v.openTabs.filter((t) => typeof t === "string");
        const activeTab = openTabs.includes(v.activeTab) ? v.activeTab : (openTabs[openTabs.length - 1] ?? null);
        const width = Number.isFinite(v.width) && v.width > 0 ? v.width : null;
        out[id] = { ...EMPTY_PANEL, open: v.open === true, openTabs, activeTab, width };
      }
      return out;
    }
  } catch {
    // corrupt/absent storage — start empty
  }
  return {};
}
function savePanels(map) {
  try {
    const out = {};
    for (const [id, s] of Object.entries(map)) {
      if (!s.open && !s.openTabs.length && !s.width) continue;
      out[id] = { open: s.open, openTabs: s.openTabs, activeTab: s.activeTab, width: s.width };
    }
    if (Object.keys(out).length) localStorage.setItem("cm:sidePanels", JSON.stringify(out));
    else localStorage.removeItem("cm:sidePanels");
  } catch {
    // storage disabled or over quota — best-effort
  }
}

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
  // ── Per-pane right side panels (open-tabs model) ──
  // Each pane (keyed by leaf id) owns its OWN panel: an open flag, an ordered
  // set of open tabs + the active one, a width, a fullscreen flag, per-tab data,
  // and the file open INSIDE the Files tab. In split view every pane opens and
  // resizes its panel independently. Opening a tab appends+activates it and
  // reveals that pane's panel; the active pill's × closes just THAT tab
  // (activating a neighbor), leaving the panel open — empty when the last tab
  // goes. Raw pane-explicit ops live here; useUi wraps them into the scope-aware
  // openPanel/setTab/closeTab/… every call site uses (they resolve to the owning
  // or focused pane). Open tabs + open flag + width persist per pane; per-tab
  // data + the open file are session-only. Default: no open tabs, panel hidden.
  const [panelsByPane, setPanelsByPane] = useState(loadPanels);
  useEffect(() => { savePanels(panelsByPane); }, [panelsByPane]);
  // Monotonic reveal seq so re-opening the same file+line re-centers the editor.
  const fileRevealSeq = useRef(0);

  const openPanelIn = useCallback((paneId, tab, data) => {
    if (!paneId) return;
    setPanelsByPane((m) => {
      const cur = m[paneId] ?? EMPTY_PANEL;
      const next = { ...cur, ...openTabReducer(cur, tab), open: true };
      if (data) next.data = { ...cur.data, [tab]: { ...cur.data[tab], ...data } };
      return { ...m, [paneId]: next };
    });
  }, []);
  const setTabIn = useCallback((paneId, tab) => openPanelIn(paneId, tab), [openPanelIn]);
  const closeTabIn = useCallback((paneId, tab) => {
    if (!paneId) return;
    setPanelsByPane((m) => {
      const cur = m[paneId] ?? EMPTY_PANEL;
      const tabs = closeTabReducer(cur, tab);
      if (tabs === cur && !(tab === "files" && cur.file)) return m;
      return { ...m, [paneId]: { ...cur, ...tabs, file: tab === "files" ? null : cur.file } };
    });
  }, []);
  // Closing the whole panel also drops fullscreen, so a later re-open comes back
  // at its normal docked width, not maximized.
  const closePanelIn = useCallback((paneId) => {
    if (!paneId) return;
    setPanelsByPane((m) => {
      const cur = m[paneId];
      if (!cur?.open) return m;
      return { ...m, [paneId]: { ...cur, open: false, fullscreen: false } };
    });
  }, []);
  const toggleSidePanelIn = useCallback((paneId) => {
    if (!paneId) return;
    setPanelsByPane((m) => {
      const cur = m[paneId] ?? EMPTY_PANEL;
      return { ...m, [paneId]: cur.open ? { ...cur, open: false, fullscreen: false } : { ...cur, open: true } };
    });
  }, []);
  // Fullscreen = maximize this pane's panel over its transcript column; toggling
  // back restores the prior docked width (width is untouched by this flag).
  const toggleFullscreenIn = useCallback((paneId) => {
    if (!paneId) return;
    setPanelsByPane((m) => {
      const cur = m[paneId] ?? EMPTY_PANEL;
      return { ...m, [paneId]: { ...cur, fullscreen: !cur.fullscreen } };
    });
  }, []);
  const setWidthIn = useCallback((paneId, px) => {
    if (!paneId) return;
    setPanelsByPane((m) => {
      const cur = m[paneId] ?? EMPTY_PANEL;
      return { ...m, [paneId]: { ...cur, width: px && px > 0 ? Math.round(px) : null } };
    });
  }, []);
  const openFileIn = useCallback((paneId, path, reveal) => {
    if (!paneId) return;
    setPanelsByPane((m) => {
      const cur = m[paneId] ?? EMPTY_PANEL;
      const file = { path, reveal: reveal ? { line: reveal.line, column: reveal.column, seq: ++fileRevealSeq.current } : null };
      return { ...m, [paneId]: { ...cur, ...openTabReducer(cur, "files"), open: true, file } };
    });
  }, []);
  const closeFileIn = useCallback((paneId) => {
    if (!paneId) return;
    setPanelsByPane((m) => {
      const cur = m[paneId];
      if (!cur?.file) return m;
      return { ...m, [paneId]: { ...cur, file: null } };
    });
  }, []);
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
    // Per-pane side panels — the raw map + pane-explicit ops. useUi resolves the
    // owning/focused pane and exposes the scope-aware reads (openTabs/activeTab/
    // showSidePanel/…) + actions (openPanel/setTab/closeTab/…) every call uses.
    panelsByPane,
    openPanelIn, setTabIn, closeTabIn, closePanelIn, toggleSidePanelIn, toggleFullscreenIn, setWidthIn, openFileIn, closeFileIn,
    rewindPanel, openRewindPanel, closeRewindPanel,
    registerEscapeIdle,
    registerEscapeGitMode,
  }), [
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, setSideCollapsed, sidebarMode,
    collapseSidebar, expandSidebar, hoverSidebarIn, hoverSidebarKeep, hoverSidebarOut,
    openPopoverByPane, popoverPos, popoverData,
    collapsedNodes, expandedTools, renamingId, pendingQuestion, dismissedQuestions, verdict,
    panelsByPane,
    openPanelIn, setTabIn, closeTabIn, closePanelIn, toggleSidePanelIn, toggleFullscreenIn, setWidthIn, openFileIn, closeFileIn,
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
