import { useUi } from "../state/ui.jsx";
import { useKeybinding } from "../keymap/useKeymap.js";

// Cmd+Ctrl+1..4 → focus the Nth split pane. Reads e.code (not e.key) so the
// digit resolves regardless of keyboard layout, and the ctrl modifier avoids the
// Cmd+1..9 agent-switch chord (no ctrl there) and Ctrl+1..4 (macOS Spaces).
// No-op when N exceeds the open pane count. Routed through the global keymap.
export function usePaneFocusHotkeys() {
  const ui = useUi();
  useKeybinding({
    match: (e) => e.metaKey && e.ctrlKey && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code),
    run: (ctx, e) => {
      const n = parseInt(/^Digit([1-9])$/.exec(e.code)[1], 10);
      if (n > ui.paneCount) return;
      e.preventDefault();
      ui.focusLeafByIndex(n - 1);
    },
  }, [ui.paneCount, ui.focusLeafByIndex]);
}
