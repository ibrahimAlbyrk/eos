import { useUi } from "../state/ui.jsx";
import { useKeybinding } from "../keymap/useKeymap.js";
import { combo } from "../keymap/index.js";

// Cmd+G → toggle the composer's git ("custom task") mode. Entering mirrors the
// popover's "Custom git task…" (close pops first); exiting mirrors the git
// button. Routed through the global keymap (see keymap/) instead of its own
// window listener.
export function useGitModeHotkey() {
  const { toggleGitMode, closeAllPops } = useUi();
  useKeybinding({
    match: combo("mod+g"),
    run: (ctx, e) => {
      e.preventDefault();
      closeAllPops();
      toggleGitMode();
    },
  }, [toggleGitMode, closeAllPops]);
}
