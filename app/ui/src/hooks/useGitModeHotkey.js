import { useEffect } from "react";
import { useUi } from "../state/ui.jsx";

// Cmd+G → toggle the composer's git ("custom task") mode. Capture phase + the
// strict modifier guard match the other Cmd hotkeys (useDeleteAgentHotkey,
// useAgentSwitchHotkeys). Entering mirrors the popover's "Custom git task…"
// (close pops first); exiting mirrors the git button.
export function useGitModeHotkey() {
  const { toggleGitMode, closeAllPops } = useUi();
  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "g" && e.key !== "G") return;
      e.preventDefault();
      closeAllPops();
      toggleGitMode();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggleGitMode, closeAllPops]);
}
