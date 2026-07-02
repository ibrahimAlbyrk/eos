import { useCallback } from "react";
import { useUi } from "../state/ui.jsx";
import { deleteDraft } from "../state/composerDrafts.js";
import { purgeAgent } from "../state/outboxStore.js";
import { purge as purgeDiff } from "../state/diffStore.js";
import { purge as purgeConflict } from "../state/conflictStore.js";
import { purge as purgeGitStatus } from "../state/gitStatusStore.js";
import { purge as purgeTerminal } from "../state/terminalStore.js";
import { dropWorker as dropThinking } from "../state/thinkingStore.js";
import { clearScrollPos } from "../lib/scrollMemory.js";
import { subtreeIds } from "../lib/tree.js";

// Shared removal funnel: archive (Cmd+W + menus) and permanent delete (menus,
// confirm-gated at the call site) both make the row (and its subtree) leave
// the /workers payload, so the selection/cache handling is one implementation:
// when it's the currently-selected agent, first re-select the agent that was
// selected before it (skipping any that no longer exist); with no usable
// history, a child falls back to its parent — only removing a root with no
// history lands on the new-session screen. Purging the per-agent client
// caches stays correct — a restored agent refetches its transcript from
// /workers/:id/events.
function useAgentRemoval(live, action, label) {
  const { selectedId, setSelectedId, takePreviousSelection, closeAllPops, removeCollapsedNodes, paneCount } = useUi();
  return useCallback(async (agentId) => {
    if (!agentId) return undefined;
    // Switch selection off the doomed agent *before* the POST so any in-flight
    // events / diff fetch for it doesn't race the row removal. In split view the
    // pane layer (prunePanes) instead removes the doomed pane and focuses a
    // survivor, so skip the re-target there and let it own the transition.
    if (selectedId === agentId && paneCount <= 1) {
      const exists = (id) => live.workers.some((w) => w.id === id);
      const parentId = live.workers.find((w) => w.id === agentId)?.parent_id;
      const fallback = takePreviousSelection(exists)
        ?? (parentId && exists(parentId) ? parentId : null);
      setSelectedId(fallback);
    }
    closeAllPops();
    // Snapshot before the await — the subtree rows are gone from live.workers
    // once the removal lands (children go in the daemon-side cascade).
    const doomedIds = subtreeIds(live.workers, agentId);
    try {
      const r = await action(agentId);
      // After the await: the selection switch above has committed by now, so
      // its draft-save (sync cleanup) already ran — deleting here can't be
      // undone by a late save under the dead id.
      if (r?.ok) {
        deleteDraft(agentId);
        removeCollapsedNodes(doomedIds);
        for (const id of doomedIds) {
          clearScrollPos(id);
          purgeAgent(id);
          purgeDiff(id);
          purgeConflict(id);
          purgeGitStatus(id);
          purgeTerminal(id);
          dropThinking(id);
        }
      }
      if (!r?.ok) {
        // eslint-disable-next-line no-console
        console.error(`${label} failed:`, r?.body?.error ?? `status ${r?.status ?? "?"}`);
      }
      return r;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`${label} threw:`, e);
      return undefined;
    }
  }, [selectedId, setSelectedId, takePreviousSelection, closeAllPops, removeCollapsedNodes, live, paneCount, action, label]);
}

// Archive an agent (the whole subtree, daemon-side). Reversible; no confirm.
export function useArchiveAgent(live) {
  return useAgentRemoval(live, live.archiveAgent, "archive");
}

// Permanently delete a LIVE agent (the old kill cascade). Menus confirm first.
export function useKillAgent(live) {
  return useAgentRemoval(live, live.killAgent, "delete");
}
