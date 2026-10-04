import { useCallback } from "react";
import { useUi } from "../state/ui.jsx";
import { useSettings } from "../state/settings.jsx";
import { setMemoryViewing } from "../state/memoryViewStore.js";

// Open the Memory view from anywhere (account menu, Settings › Profile, a
// notification): close what's floating, switch to the Agents view, take over its
// main area.
export function useOpenMemory() {
  const { closeAllPops, setActiveView } = useUi();
  const { closeSettings } = useSettings();
  return useCallback(() => {
    closeSettings();
    closeAllPops();
    setActiveView("agents");
    setMemoryViewing(true);
  }, [closeAllPops, setActiveView, closeSettings]);
}
