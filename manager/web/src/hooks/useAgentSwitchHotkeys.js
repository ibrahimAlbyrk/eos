import { useEffect } from "react";
import { useUi } from "../state/ui.jsx";
import { agentIdAtIndex } from "../lib/tree.js";

// Cmd+1..9 → select the Nth agent in the sidebar's visible order.
export function useAgentSwitchHotkeys(live) {
  const ui = useUi();
  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const n = parseInt(e.key, 10);
      if (!(n >= 1 && n <= 9)) return;
      const id = agentIdAtIndex(live.workers, ui.collapsedNodes, n - 1);
      if (!id) return;
      e.preventDefault();
      ui.setSelectedId(id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [live.workers, ui.collapsedNodes, ui.setSelectedId]);
}
