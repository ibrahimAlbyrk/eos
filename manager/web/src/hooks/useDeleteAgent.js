import { useCallback } from "react";
import { useUi } from "../state/ui.jsx";
import { deleteDraft } from "../state/composerDrafts.js";

// Delete an agent. When it's the currently-selected one, first re-select the
// agent that was selected before it (skipping any that no longer exist), then
// kill it. Shared by the Cmd+W hotkey and the sidebar context menu so both
// entry points behave identically.
export function useDeleteAgent(live) {
  const { selectedId, setSelectedId, takePreviousSelection, closeAllPops } = useUi();
  return useCallback(async (agentId) => {
    if (!agentId) return undefined;
    // Switch selection off the doomed agent *before* the DELETE so any in-flight
    // events / diff fetch for it doesn't race the row removal.
    if (selectedId === agentId) {
      const fallback = takePreviousSelection((id) => live.workers.some((w) => w.id === id));
      setSelectedId(fallback);
    }
    closeAllPops();
    try {
      const r = await live.killAgent(agentId);
      // After the await: the selection switch above has committed by now, so
      // its draft-save (sync cleanup) already ran — deleting here can't be
      // undone by a late save under the dead id.
      if (r?.ok) deleteDraft(agentId);
      if (!r?.ok) {
        // eslint-disable-next-line no-console
        console.error("kill failed:", r?.body?.error ?? `status ${r?.status ?? "?"}`);
      }
      return r;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("kill threw:", e);
      return undefined;
    }
  }, [selectedId, setSelectedId, takePreviousSelection, closeAllPops, live]);
}
