import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const SearchContext = createContext(null);

// Owns the command palette's open state and the global ⌘K / Ctrl+K shortcut.
// Kept separate from selection/navigation so any tab can open search without
// pulling in Code-specific state.
export function SearchProvider({ children }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  useEffect(() => {
    const onKey = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.altKey || e.shiftKey) return;
      if (e.key !== "k" && e.key !== "K") return;
      e.preventDefault();
      setSearchOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const value = useMemo(
    () => ({ searchOpen, openSearch, closeSearch }),
    [searchOpen, openSearch, closeSearch],
  );
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export function useSearch() {
  const c = useContext(SearchContext);
  if (!c) throw new Error("useSearch outside SearchProvider");
  return c;
}
