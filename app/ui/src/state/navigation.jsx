import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { TABS, visibleTabs } from "../views/tabs.js";
import { useFeatures } from "./featuresStore.js";
import { ensureEosStatusLoaded, useEosShown } from "./eos/eosStatusStore.js";

const NavigationContext = createContext(null);

// A stored id is kept while its view is hidden, so a view that shows only once
// the core has answered (Eos) still opens where the user left. An id no view
// has (e.g. the removed Home) falls back to the first view.
export function initialView() {
  const stored = localStorage.getItem("cm:activeView");
  return TABS.some((t) => t.id === stored) ? stored : visibleTabs()[0].id;
}

// The view on screen: the chosen one, or the first view while it is hidden.
export function shownView(activeViewId) {
  const tabs = visibleTabs();
  return tabs.some((t) => t.id === activeViewId) ? activeViewId : tabs[0].id;
}

export function NavigationProvider({ children }) {
  const [activeViewId, _setActiveViewId] = useState(initialView);
  const setActiveView = useCallback((id) => {
    _setActiveViewId(id);
    if (id) localStorage.setItem("cm:activeView", id);
  }, []);

  // The first view also stands in for one this computer turns out not to offer
  // (Machines, once the daemon says it can't pair; Eos, until the core says it
  // serves routines).
  useFeatures();
  useEosShown();
  useEffect(() => { ensureEosStatusLoaded(); }, []);
  const shownId = shownView(activeViewId);

  const value = useMemo(() => ({ activeViewId: shownId, setActiveView }), [shownId, setActiveView]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation() {
  const c = useContext(NavigationContext);
  if (!c) throw new Error("useNavigation outside NavigationProvider");
  return c;
}
