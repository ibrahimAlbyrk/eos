import { useEffect } from "react";
import { useUi } from "../state/ui.jsx";
import { useDeleteAgent } from "./useDeleteAgent.js";

// Cmd+W → delete the selected agent, falling back to the previously-selected
// one. Capture phase + the strict modifier guard match the other Cmd hotkeys
// (useAgentSwitchHotkeys, Cmd+T). No native Close-Window item is bound to Cmd+W,
// so the key reaches the WKWebView unclaimed.
export function useDeleteAgentHotkey(live) {
  const { selectedId } = useUi();
  const deleteAgent = useDeleteAgent(live);
  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "w" && e.key !== "W") return;
      if (!selectedId) return;
      e.preventDefault();
      deleteAgent(selectedId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [selectedId, deleteAgent]);
}
