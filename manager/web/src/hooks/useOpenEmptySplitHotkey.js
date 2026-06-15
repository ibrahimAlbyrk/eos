import { useEffect } from "react";
import { useUi } from "../state/ui.jsx";

// Cmd+Ctrl+T → open an empty split pane (mirrors the header SplitEmptyButton).
// Joins the Cmd+Ctrl chord family (usePaneFocusHotkeys) so it reads e.code for
// layout independence and doesn't collide with plain Cmd+T (new empty session,
// no ctrl). The MAX_PANES guard lives in ui.openEmptySplit — single source.
export function useOpenEmptySplitHotkey() {
  const { openEmptySplit } = useUi();
  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey || !e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.code !== "KeyT") return;
      e.preventDefault();
      openEmptySplit();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openEmptySplit]);
}
