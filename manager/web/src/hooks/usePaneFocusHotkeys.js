import { useEffect } from "react";
import { useUi } from "../state/ui.jsx";

// Cmd+Ctrl+1..4 → focus the Nth split pane. Reads e.code (not e.key) so the
// digit resolves regardless of keyboard layout/modifiers, and avoids the
// Cmd+1..9 agent-switch chord (no ctrl there) and Ctrl+1..4 (macOS Spaces).
// No-op when N exceeds the open pane count.
export function usePaneFocusHotkeys() {
  const ui = useUi();
  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey || !e.ctrlKey || e.altKey || e.shiftKey) return;
      const m = /^Digit([1-4])$/.exec(e.code);
      if (!m) return;
      const n = parseInt(m[1], 10);
      if (n > ui.paneCount) return;
      e.preventDefault();
      ui.focusPane(n - 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ui.paneCount, ui.focusPane]);
}
