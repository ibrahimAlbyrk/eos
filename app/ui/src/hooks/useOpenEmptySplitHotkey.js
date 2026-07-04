import { useUi } from "../state/ui.jsx";
import { useKeybinding } from "../keymap/useKeymap.js";
import { combo } from "../keymap/index.js";

// Cmd+Ctrl+T → open an empty split pane.
// Reads e.code for layout independence; the ctrl modifier keeps it disjoint from
// plain Cmd+T (new empty session). The MAX_PANES guard lives in
// ui.openEmptySplit — single source. Routed through the global keymap.
export function useOpenEmptySplitHotkey() {
  const { openEmptySplit } = useUi();
  useKeybinding({
    match: combo("mod+ctrl+t", { code: true }),
    run: (ctx, e) => {
      e.preventDefault();
      openEmptySplit();
    },
  }, [openEmptySplit]);
}
