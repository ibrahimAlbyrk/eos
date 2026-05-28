import { createContext, useCallback, useContext, useMemo, useState } from "react";

const NavigationContext = createContext(null);

export function NavigationProvider({ children }) {
  const [activeViewId, _setActiveViewId] = useState(() => localStorage.getItem("cm:activeView") || "code");
  const setActiveView = useCallback((id) => {
    _setActiveViewId(id);
    if (id) localStorage.setItem("cm:activeView", id);
  }, []);

  const value = useMemo(() => ({ activeViewId, setActiveView }), [activeViewId, setActiveView]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation() {
  const c = useContext(NavigationContext);
  if (!c) throw new Error("useNavigation outside NavigationProvider");
  return c;
}
