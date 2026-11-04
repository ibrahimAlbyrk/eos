import { useUi, useSettings } from "../state/ui.jsx";
import { useArchiveAgent, useKillAgent } from "./useArchiveAgent.js";
import { useKeybinding } from "../keymap/useKeymap.js";
import { combo } from "../keymap/index.js";

// Cmd+W → remove the selected agent (falls back to the previously-selected
// one). What "remove" means is the archive.cmdW setting: archive (reversible,
// the default — also when config hasn't loaded) or permanent delete (the
// pre-archive UX, deliberately opted into — no confirm; the menus' Delete
// keeps its confirm). Exception: an EMPTY split pane has no agent (selectedId
// null), so close that pane instead — the keyboard equivalent of its X button.
// No native Close-Window item is bound to Cmd+W, so the key reaches the
// WKWebView unclaimed. Routed through the global keymap.
export function useArchiveAgentHotkey(live) {
  const { selectedId, focusedLeafId, paneCount, closeLeaf } = useUi();
  const { settings } = useSettings();
  const archiveAgent = useArchiveAgent(live);
  const killAgent = useKillAgent(live);
  const removeAgent = settings["archive.cmdW"] === "delete" ? killAgent : archiveAgent;
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
      removeAgent(selectedId);
    },
  }, [selectedId, focusedLeafId, paneCount, closeLeaf, removeAgent]);
}
