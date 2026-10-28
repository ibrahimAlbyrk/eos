import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { visibleTabs } from "../views/tabs.js";
import { useFeatures } from "./featuresStore.js";

const NavigationContext = createContext(null);

// A stored id for a view that no longer exists (e.g. the removed Home) falls
// back to the first view.
function initialView() {
  const stored = localStorage.getItem("cm:activeView");
  const tabs = visibleTabs();
  return tabs.some((t) => t.id === stored) ? stored : tabs[0].id;
}

export function NavigationProvider({ children }) {
  const [activeViewId, _setActiveViewId] = useState(initialView);
  const setActiveView = useCallback((id) => {
    _setActiveViewId(id);
    if (id) localStorage.setItem("cm:activeView", id);
  }, []);

  // The first view also stands in for one this computer turns out not to offer
  // (Machines, once the daemon says it can't pair).
  useFeatures();
  const tabs = visibleTabs();
  const shownId = tabs.some((t) => t.id === activeViewId) ? activeViewId : tabs[0].id;

  const value = useMemo(() => ({ activeViewId: shownId, setActiveView }), [shownId, setActiveView]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation() {
  const c = useContext(NavigationContext);
  if (!c) throw new Error("useNavigation outside NavigationProvider");
  return c;
}
