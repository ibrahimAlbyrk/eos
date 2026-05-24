import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const SelectionContext = createContext(null);

export function SelectionProvider({ children }) {
  const [selectedId, setSelectedId] = useState(null);
  const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem("cm:sideCollapsed") === "1");
  const [islandsHidden, setIslandsHidden] = useState(() => localStorage.getItem("cm:islandsHidden") === "1");

  useEffect(() => { localStorage.setItem("cm:sideCollapsed", sideCollapsed ? "1" : "0"); }, [sideCollapsed]);
  useEffect(() => { localStorage.setItem("cm:islandsHidden", islandsHidden ? "1" : "0"); }, [islandsHidden]);
  const [openPopover, setOpenPopover] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverData, setPopoverData] = useState({});
  const [collapsedNodes, setCollapsedNodes] = useState(() => new Set());
  const [fileViewer, setFileViewer] = useState(null);

  const openPop = useCallback((id, opts = {}) => {
    setOpenPopover(id);
    if (opts.x != null && opts.y != null) setPopoverPos({ x: opts.x, y: opts.y });
    if (opts.data) setPopoverData(opts.data);
  }, []);
  const closeAllPops = useCallback(() => {
    setOpenPopover(null);
    setPopoverData({});
  }, []);

  useEffect(() => { setFileViewer(null); }, [selectedId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { closeAllPops(); setFileViewer(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAllPops]);

  const toggleNodeCollapsed = useCallback((id) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const openFileViewer = useCallback((path) => {
    setFileViewer({ path, editMode: false });
  }, []);
  const closeFileViewer = useCallback(() => setFileViewer(null), []);
  const toggleFileEditMode = useCallback(() => {
    setFileViewer((prev) => prev ? { ...prev, editMode: !prev.editMode } : null);
  }, []);

  const value = useMemo(() => ({
    selectedId, setSelectedId,
    sideCollapsed, setSideCollapsed,
    islandsHidden, setIslandsHidden,
    openPopover, openPop, closeAllPops, popoverPos, popoverData,
    collapsedNodes, toggleNodeCollapsed,
    fileViewer, openFileViewer, closeFileViewer, toggleFileEditMode,
  }), [
    selectedId, sideCollapsed, islandsHidden, openPopover, popoverPos, popoverData,
    collapsedNodes, fileViewer,
    openPop, closeAllPops, toggleNodeCollapsed,
    openFileViewer, closeFileViewer, toggleFileEditMode,
  ]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection() {
  const c = useContext(SelectionContext);
  if (!c) throw new Error("useSelection outside SelectionProvider");
  return c;
}
