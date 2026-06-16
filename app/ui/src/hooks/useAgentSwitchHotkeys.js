import { useUi } from "../state/ui.jsx";
import { agentIdAtIndex } from "../lib/tree.js";
import { useKeybinding } from "../keymap/useKeymap.js";
import { isMod } from "../keymap/index.js";

// Cmd+1..9 → select the Nth agent in the sidebar's visible order. Routed through
// the global keymap (see keymap/). No-op when there's no agent at that index —
// the key is left unclaimed, exactly as before.
export function useAgentSwitchHotkeys(live) {
  const ui = useUi();
  useKeybinding({
    match: (e) => isMod(e) && /^[1-9]$/.test(e.key),
    run: (ctx, e) => {
      const n = parseInt(e.key, 10);
      const id = agentIdAtIndex(live.workers, ui.collapsedNodes, n - 1);
      if (!id) return;
      e.preventDefault();
      ui.selectAgent(id);
    },
  }, [live.workers, ui.collapsedNodes, ui.selectAgent]);
}
