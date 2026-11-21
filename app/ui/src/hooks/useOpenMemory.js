import { useCallback } from "react";
import { useUi } from "../state/ui.jsx";
import { useSettings } from "../state/settings.jsx";
import { setMemoryViewing } from "../state/memoryViewStore.js";
import { isEosShown } from "../state/eos/eosStatusStore.js";
import { openEosRoute } from "../views/eos/nav/eosNav.js";

// Open Memory from anywhere (account menu, Settings › Profile, a notification):
// close what's floating, then Eos › Memory › About you while Eos is shown, or
// the Agents view with Memory taking over its main area while it is hidden.
export function useOpenMemory() {
  const { closeAllPops, setActiveView } = useUi();
  const { closeSettings } = useSettings();
  return useCallback(() => {
    closeSettings();
    closeAllPops();
    if (isEosShown()) {
      openEosRoute("eos:/memory?tab=about", setActiveView);
      return;
    }
    setActiveView("agents");
    setMemoryViewing(true);
  }, [closeAllPops, setActiveView, closeSettings]);
}
