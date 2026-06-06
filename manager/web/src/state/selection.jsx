import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const SelectionContext = createContext(null);

export function SelectionProvider({ children }) {
  const [selectedId, _setSelectedId] = useState(() => localStorage.getItem("cm:selectedId"));
  const setSelectedId = useCallback((id) => {
    _setSelectedId(id);
    if (id) localStorage.setItem("cm:selectedId", id);
    else localStorage.removeItem("cm:selectedId");
  }, []);
  const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem("cm:sideCollapsed") === "1");

  useEffect(() => { localStorage.setItem("cm:sideCollapsed", sideCollapsed ? "1" : "0"); }, [sideCollapsed]);
  const [openPopover, setOpenPopover] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverData, setPopoverData] = useState({});
  const [collapsedNodes, setCollapsedNodes] = useState(() => new Set());
  const [expandedTools, setExpandedTools] = useState(() => new Set());
  const [fileViewer, setFileViewer] = useState(null);
  const [agentViewer, setAgentViewer] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [dismissedQuestions, setDismissedQuestions] = useState(() => new Set());
  const dismissQuestion = useCallback((toolUseId) => {
    setDismissedQuestions((prev) => new Set(prev).add(toolUseId));
  }, []);
  const escapeIdleRef = useRef(null);
  const registerEscapeIdle = useCallback((fn) => { escapeIdleRef.current = fn; }, []);

  const openPop = useCallback((id, opts = {}) => {
    setOpenPopover(id);
    if (opts.x != null && opts.y != null) setPopoverPos({ x: opts.x, y: opts.y });
    if (opts.data) setPopoverData(opts.data);
  }, []);
  const closeAllPops = useCallback(() => {
    setOpenPopover(null);
    setPopoverData({});
  }, []);

  useEffect(() => { setFileViewer(null); setAgentViewer(null); }, [selectedId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (openPopover) { closeAllPops(); return; }
      if (agentViewer) { setAgentViewer(null); return; }
      if (fileViewer) { setFileViewer(null); return; }
      if (escapeIdleRef.current) { e.preventDefault(); escapeIdleRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAllPops, openPopover, fileViewer, agentViewer]);

  const toggleNodeCollapsed = useCallback((id) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleToolExpanded = useCallback((id) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const openFileViewer = useCallback((path) => {
    setAgentViewer(null);
    setFileViewer({ path });
  }, []);
  const closeFileViewer = useCallback(() => setFileViewer(null), []);
  const openAgentViewer = useCallback((block) => {
    setFileViewer(null);
    setAgentViewer(block);
  }, []);
  const closeAgentViewer = useCallback(() => setAgentViewer(null), []);
  const syncAgentViewer = useCallback((block) => {
    setAgentViewer((prev) => prev && prev.toolUseId === block.toolUseId ? block : prev);
  }, []);

  const value = useMemo(() => ({
    selectedId, setSelectedId,
    sideCollapsed, setSideCollapsed,
    openPopover, openPop, closeAllPops, popoverPos, popoverData,
    collapsedNodes, toggleNodeCollapsed,
    expandedTools, toggleToolExpanded,
    renamingId, setRenamingId,
    pendingQuestion, setPendingQuestion, dismissedQuestions, dismissQuestion,
    fileViewer, openFileViewer, closeFileViewer,
    agentViewer, openAgentViewer, closeAgentViewer, syncAgentViewer,
    registerEscapeIdle,
  }), [
    selectedId, sideCollapsed, openPopover, popoverPos, popoverData,
    collapsedNodes, expandedTools, renamingId, pendingQuestion, dismissedQuestions, fileViewer, agentViewer,
    openPop, closeAllPops, toggleNodeCollapsed, toggleToolExpanded,
    openFileViewer, closeFileViewer,
    openAgentViewer, closeAgentViewer, syncAgentViewer,
    registerEscapeIdle,
  ]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection() {
  const c = useContext(SelectionContext);
  if (!c) throw new Error("useSelection outside SelectionProvider");
  return c;
}
