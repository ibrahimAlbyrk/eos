import { useUi } from "../state/ui.jsx";
import { useDeleteAgent } from "./useDeleteAgent.js";
import { useKeybinding } from "../keymap/useKeymap.js";
import { combo } from "../keymap/index.js";

// Cmd+W → delete the selected agent (falls back to the previously-selected one).
// Exception: an EMPTY split pane has no agent (selectedId null), so close that
// pane instead — the keyboard equivalent of its X button. No native Close-Window
// item is bound to Cmd+W, so the key reaches the WKWebView unclaimed. Routed
// through the global keymap.
export function useDeleteAgentHotkey(live) {
  const { selectedId, focusedLeafId, paneCount, closeLeaf } = useUi();
  const deleteAgent = useDeleteAgent(live);
  useKeybinding({
    match: combo("mod+w"),
    run: (ctx, e) => {
      if (!selectedId) {
        // Focused pane is empty: close it instead. Split only — closeLeaf guards
        // the last pane, and a single empty pane has nothing to close.
        if (paneCount > 1) {
          e.preventDefault();
          closeLeaf(focusedLeafId);
        }
        return;
      }
      e.preventDefault();
      deleteAgent(selectedId);
    },
  }, [selectedId, focusedLeafId, paneCount, closeLeaf, deleteAgent]);
}
