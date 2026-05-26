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
  const [islandsHidden, setIslandsHidden] = useState(() => localStorage.getItem("cm:islandsHidden") === "1");

  useEffect(() => { localStorage.setItem("cm:sideCollapsed", sideCollapsed ? "1" : "0"); }, [sideCollapsed]);
  useEffect(() => { localStorage.setItem("cm:islandsHidden", islandsHidden ? "1" : "0"); }, [islandsHidden]);
  const [openPopover, setOpenPopover] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverData, setPopoverData] = useState({});
  const [collapsedNodes, setCollapsedNodes] = useState(() => new Set());
  const [fileViewer, setFileViewer] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
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

  useEffect(() => { setFileViewer(null); }, [selectedId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (openPopover) { closeAllPops(); return; }
      if (fileViewer) { setFileViewer(null); return; }
      if (escapeIdleRef.current) { e.preventDefault(); escapeIdleRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAllPops, openPopover, fileViewer]);

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
    renamingId, setRenamingId,
    fileViewer, openFileViewer, closeFileViewer, toggleFileEditMode,
    registerEscapeIdle,
  }), [
    selectedId, sideCollapsed, islandsHidden, openPopover, popoverPos, popoverData,
    collapsedNodes, renamingId, fileViewer,
    openPop, closeAllPops, toggleNodeCollapsed,
    openFileViewer, closeFileViewer, toggleFileEditMode,
    registerEscapeIdle,
  ]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection() {
  const c = useContext(SelectionContext);
  if (!c) throw new Error("useSelection outside SelectionProvider");
  return c;
}
