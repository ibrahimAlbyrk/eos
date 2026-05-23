import { useEffect } from "react";
import { UiProvider, useUi } from "./state/ui.jsx";
import { useLive } from "./hooks/useLive.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { Sidebar } from "./components/sidebar/Sidebar.jsx";
import { SideHandle } from "./components/sidebar/SideHandle.jsx";
import { CenterHeader } from "./components/center/CenterHeader.jsx";
import { Messages } from "./components/messages/Messages.jsx";
import { Composer } from "./components/center/Composer.jsx";
import { Islands } from "./components/islands/Islands.jsx";
import { IslandHandle } from "./components/islands/IslandHandle.jsx";
import { AgentContextMenu } from "./components/popovers/AgentContextMenu.jsx";
import { QuickPromptModal } from "./components/popovers/QuickPromptModal.jsx";

function Shell() {
  const ui = useUi();
  const live = useLive();

  // Auto-select first orchestrator on first load
  useEffect(() => {
    if (!ui.selectedId && live.orchestrators.length > 0) {
      ui.setSelectedId(live.orchestrators[0].id);
    }
  }, [ui.selectedId, live.orchestrators, ui.setSelectedId]);

  // Seed unseen workers so brand-new agents don't immediately notify.
  useEffect(() => {
    for (const w of live.workers) ui.seedViewed(w);
  }, [live.workers, ui.seedViewed]);

  // Continuously mark the currently-selected worker as viewed so its
  // notification badge never fires while the user is actively looking at it.
  useEffect(() => {
    const w = live.workers.find((x) => x.id === ui.selectedId);
    if (w) ui.markViewed(w);
  }, [ui.selectedId, live.workers, ui.markViewed]);

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

  const cls = ["app"];
  if (ui.sideCollapsed) cls.push("side-collapsed");
  // Mark the layout when the islands column is occupying the right side, so
  // messages/composer can reserve space for it instead of being overlapped
  // by the absolute-positioned cards on narrower viewports.
  const selectedWorker = live.workers.find((w) => w.id === ui.selectedId);
  const islandsVisible = !!selectedWorker && !ui.islandsHidden;
  if (islandsVisible) cls.push("has-islands");

  return (
    <div className={cls.join(" ")}>
      <Sidebar live={live} />
      <SideHandle />

      <section className="center">
        <CenterHeader live={live} />
        <Messages live={live} />
        <Composer live={live} />
      </section>

      <Islands live={live} />
      <IslandHandle />

      <AgentContextMenu live={live} />
      <QuickPromptModal live={live} />
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <UiProvider>
        <Shell />
      </UiProvider>
    </ErrorBoundary>
  );
}
