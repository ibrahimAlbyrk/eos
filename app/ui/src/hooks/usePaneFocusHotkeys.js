import { useUi } from "../state/ui.jsx";
import { useKeybinding } from "../keymap/useKeymap.js";

// Cmd+Opt+1..4 → focus the Nth split pane. Reads e.code (not e.key) so the
// digit resolves regardless of keyboard layout (Opt changes e.key), and the opt
// modifier avoids Cmd+1..9 (agent switch) and Cmd+Ctrl+1..9 (view switch).
// No-op when N exceeds the open pane count. Routed through the global keymap.
export function usePaneFocusHotkeys() {
  const ui = useUi();
  useKeybinding({
    // Pane navigation stays live even from inside a focused terminal.
    terminalSafe: true,
    match: (e) => e.metaKey && e.altKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code),
    run: (ctx, e) => {
      const n = parseInt(/^Digit([1-9])$/.exec(e.code)[1], 10);
      if (n > ui.paneCount) return;
      e.preventDefault();
      ui.focusLeafByIndex(n - 1);
    },
  }, [ui.paneCount, ui.focusLeafByIndex]);
}
