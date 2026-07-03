import { useEffect, useSyncExternalStore } from "react";
import { useUi } from "../../state/ui.jsx";
import { subscribe, getArchive } from "../../state/archiveStore.js";
import { useAgentSwitchHotkeys } from "../../hooks/useAgentSwitchHotkeys.js";
import { usePaneFocusHotkeys } from "../../hooks/usePaneFocusHotkeys.js";
import { useArchiveAgentHotkey } from "../../hooks/useArchiveAgentHotkey.js";
import { useGitModeHotkey } from "../../hooks/useGitModeHotkey.js";
import { useOpenEmptySplitHotkey } from "../../hooks/useOpenEmptySplitHotkey.js";
import { useGlobalKeymap, useKeybinding } from "../../keymap/useKeymap.js";
import { combo } from "../../keymap/index.js";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { CodeSidebar } from "./sidebar/CodeSidebar.jsx";
import { CenterHeader } from "./center/CenterHeader.jsx";
import { PaneGrid, SinglePane } from "./panes/PaneGrid.jsx";
import { AgentContextMenu } from "./popovers/AgentContextMenu.jsx";
import { RewindPanel } from "./center/RewindPanel.jsx";
import { ArchiveView } from "../archive/ArchiveView.jsx";
import { ArchiveContextMenu } from "../archive/ArchiveContextMenu.jsx";

export function CodeView({ live }) {
  const ui = useUi();
  const { archiveMode } = useSyncExternalStore(subscribe, getArchive);

  // One capture-phase window listener for every keymap binding below (and any
  // future view binding) — replaces the per-hook listeners one at a time.
  useGlobalKeymap();

  // Cmd+1..9 → select Nth visible agent in the sidebar.
  useAgentSwitchHotkeys(live);

  // Cmd+Ctrl+1..4 → focus the Nth split pane.
  usePaneFocusHotkeys();

  // Cmd+W → archive the selected agent (falls back to the previous selection).
  useArchiveAgentHotkey(live);

  // Cmd+G → toggle the composer's git custom-task mode.
  useGitModeHotkey();

  // Cmd+Ctrl+T → open an empty split pane (mirrors the header split button).
  useOpenEmptySplitHotkey();

  // Cmd+T → new empty session (mirrors the + button).
  useKeybinding({
    match: combo("mod+t"),
    run: (ctx, e) => {
      e.preventDefault();
      ui.setSelectedId(null);
    },
  }, [ui.setSelectedId]);

  // Last agent removed → reset to the clean new-session state, in ANY layout.
  // `live.loaded` so an empty list during the initial fetch isn't mistaken for
  // "all deleted". Both cleanup effects below bail when the list is empty, so
  // this is the single owner of that transition (single-pane archive already
  // self-heals via useArchiveAgent; this covers the split case whose multi-pane
  // path defers to prunePanes — which can't run once the list is empty).
  useEffect(() => {
    if (!live.loaded || live.workers.length > 0) return;
    ui.resetToEmpty();
  }, [live.loaded, live.workers.length, ui.resetToEmpty]);

  // Clear selection if the selected worker no longer exists. Leaving
  // selectedId null is intentional (user pressed +, or first launch) and
  // must not auto-fallback to another orchestrator. Skip when workers is
  // empty — it can't tell "not loaded yet" from "no workers", and clearing
  // a persisted selection during the initial fetch would lose it.
  useEffect(() => {
    if (!ui.selectedId) return;
    if (live.workers.length === 0) return;
    const exists = live.workers.some((w) => w.id === ui.selectedId);
    // Single pane only: empty it when its agent dies. In split, prunePanes owns
    // death — it removes the dead pane and focuses a survivor (so we must not
    // null selectedId here and turn the focused pane empty before it runs).
    if (!exists && ui.paneCount <= 1) ui.setSelectedId(null);
  }, [ui.selectedId, live.workers, ui.setSelectedId, ui.paneCount]);

  // Drop dead agents from the non-focused split panes (the focused pane rides
  // the selectedId cleanup above). Same guard: an empty list can't tell "not
  // loaded yet" from "no workers". Skipped in follow-mode — reconcileFollow
  // rebuilds from the live set and already owns which children show.
  useEffect(() => {
    if (ui.followMode) return;
    if (live.workers.length === 0) return;
    const alive = new Set(live.workers.map((w) => w.id));
    ui.prunePanes((id) => alive.has(id));
  }, [live.workers, ui.prunePanes, ui.followMode]);

  // Follow-mode: keep the split mirroring the active orchestrator's children as
  // workers spawn / change state / are killed, and re-fanout when the selection
  // moves to a different orchestrator (selectedId dep). reconcileFollow is
  // idempotent, so the frequent SSE-driven workers refetch is cheap when nothing
  // relevant changed.
  useEffect(() => {
    if (!ui.followMode) return;
    if (live.workers.length === 0) return;
    ui.reconcileFollow(live.workers);
  }, [live.workers, ui.followMode, ui.selectedId, ui.reconcileFollow]);

  useEffect(() => {
    ui.registerEscapeIdle(() => {
      const w = live.workers.find((x) => x.id === ui.selectedId);
      if (w && (w.state === "SPAWNING" || w.state === "WORKING")) {
        // The interrupt route also clears the daemon-side message queue, so
        // Esc still cancels everything the user queued.
        live.interruptAgent(w.id);
      }
    });
  }, [ui.selectedId, live.workers, live.interruptAgent, ui.registerEscapeIdle]);

  // Outside-click closes any open popover (except the popover itself + trigger)
  useEffect(() => {
    if (!ui.openPopover) return;
    const handler = (e) => {
      const inside = e.target.closest(`[data-popover="${ui.openPopover}"]`)
        || e.target.closest(`[data-popover-trigger="${ui.openPopover}"]`);
      if (!inside) ui.closeAllPops();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ui.openPopover, ui]);

  // The right panels dock as a sibling surface immediately right of the FOCUSED
  // pane, INSIDE the pane grid (see PaneGrid/SinglePane) — not the window's right
  // column — so the window grid never resizes for a panel. Only `split` remains.
  const gridClass = ui.paneCount > 1 ? "split" : "";

  return (
    <AppLayout
      gridClass={gridClass}
      sidebar={(variant) => <CodeSidebar live={live} variant={variant} />}
      main={
        archiveMode ? (
          // Archive mode replaces the main area with the archive panel; the
          // pane tree below stays untouched in ui state, so toggling off
          // remounts the exact layout/selection the user left.
          <ArchiveView live={live} />
        ) : (
          <>
            <CenterHeader live={live} />
            {/* Single pane keeps the keep-alive multiplexer (instant switch-back).
                Split view (2-4 panes) lays the transcripts out side by side. The
                composer now lives INSIDE each pane (owned by that pane); the grid
                fills the height the shared composer used to occupy. Each pane also
                renders its own docked panel adjacent to it (see PaneViewers). */}
            {ui.paneCount > 1
              ? <PaneGrid live={live} />
              : <SinglePane live={live} />}
          </>
        )
      }
    >
      <AgentContextMenu live={live} />
      <ArchiveContextMenu live={live} />
      {ui.rewindPanel && <RewindPanel live={live} />}
    </AppLayout>
  );
}
