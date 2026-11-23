import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { TABS, visibleTabs } from "../views/tabs.js";
import { useFeatures } from "./featuresStore.js";
import { ensureEosStatusLoaded, useEosShown } from "./eos/eosStatusStore.js";
import { noteViewAtStart } from "./eos/movedShortcuts.js";

const NavigationContext = createContext(null);

// A stored id is kept while its view is hidden, so a view that shows only once
// the core has answered (Eos) still opens where the user left. A new user, or
// an id no view has (e.g. the removed Home), starts on the first view, Eos
// (D2): until the core answers, the first visible view stands in.
export function initialView() {
  const stored = localStorage.getItem("cm:activeView");
  noteViewAtStart(stored);
  return TABS.some((t) => t.id === stored) ? stored : TABS[0].id;
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

// The navigation where there may be none: Eos's screens draw in the sample
// gallery too, which has no provider.
export function useNavigationIfAny() {
  return useContext(NavigationContext);
}
