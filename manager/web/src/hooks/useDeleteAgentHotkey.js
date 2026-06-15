import { useEffect } from "react";
import { useUi } from "../state/ui.jsx";
import { useDeleteAgent } from "./useDeleteAgent.js";

// Cmd+W → delete the selected agent, falling back to the previously-selected
// one. Exception: when an EMPTY split pane is focused there's no agent to
// delete (selectedId is null), so close that pane instead — the keyboard
// equivalent of its X button. Capture phase + the strict modifier guard match
// the other Cmd hotkeys (useAgentSwitchHotkeys, Cmd+T). No native Close-Window
// item is bound to Cmd+W, so the key reaches the WKWebView unclaimed.
export function useDeleteAgentHotkey(live) {
  const { selectedId, focusedLeafId, paneCount, closeLeaf } = useUi();
  const deleteAgent = useDeleteAgent(live);
  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "w" && e.key !== "W") return;
      if (!selectedId) {
        // Focused pane is empty: close it instead. Split only — closeLeaf
        // guards the last pane, and a single empty pane has nothing to close.
        if (paneCount > 1) {
          e.preventDefault();
          closeLeaf(focusedLeafId);
        }
        return;
      }
      e.preventDefault();
      deleteAgent(selectedId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedId, focusedLeafId, paneCount, closeLeaf, deleteAgent]);
}
