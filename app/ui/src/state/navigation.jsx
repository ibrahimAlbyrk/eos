import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { TABS } from "../views/tabs.js";

const NavigationContext = createContext(null);

// A stored id for a view that no longer exists (e.g. the removed Home) falls
// back to the first view.
function initialView() {
  const stored = localStorage.getItem("cm:activeView");
  return TABS.some((t) => t.id === stored) ? stored : TABS[0].id;
}

export function NavigationProvider({ children }) {
  const [activeViewId, _setActiveViewId] = useState(initialView);
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
