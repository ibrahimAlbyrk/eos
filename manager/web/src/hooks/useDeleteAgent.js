import { useCallback } from "react";
import { useUi } from "../state/ui.jsx";
import { deleteDraft } from "../state/composerDrafts.js";

// Delete an agent. When it's the currently-selected one, first re-select the
// agent that was selected before it (skipping any that no longer exist); with
// no usable history, a child falls back to its parent — only deleting a root
// with no history lands on the new-session screen. Shared by the Cmd+W hotkey
// and the context/header menus so all entry points behave identically.
export function useDeleteAgent(live) {
  const { selectedId, setSelectedId, takePreviousSelection, closeAllPops, purgeAgentMessages } = useUi();
  return useCallback(async (agentId) => {
    if (!agentId) return undefined;
    // Switch selection off the doomed agent *before* the DELETE so any in-flight
    // events / diff fetch for it doesn't race the row removal.
    if (selectedId === agentId) {
      const exists = (id) => live.workers.some((w) => w.id === id);
      const parentId = live.workers.find((w) => w.id === agentId)?.parent_id;
      const fallback = takePreviousSelection(exists)
        ?? (parentId && exists(parentId) ? parentId : null);
      setSelectedId(fallback);
    }
    closeAllPops();
    try {
      const r = await live.killAgent(agentId);
      // After the await: the selection switch above has committed by now, so
      // its draft-save (sync cleanup) already ran — deleting here can't be
      // undone by a late save under the dead id.
      if (r?.ok) {
        deleteDraft(agentId);
        purgeAgentMessages(agentId);
      }
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
  }, [selectedId, setSelectedId, takePreviousSelection, closeAllPops, purgeAgentMessages, live]);
}
