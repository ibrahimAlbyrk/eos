import { useEffect, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { Sidebar } from "./sidebar/Sidebar.jsx";
import { SideHandle } from "./sidebar/SideHandle.jsx";
import { SidePopup } from "./sidebar/SidePopup.jsx";
import { CenterHeader } from "./center/CenterHeader.jsx";
import { Composer } from "./center/Composer.jsx";
import { Messages } from "./messages/Messages.jsx";
import { FileViewer } from "./messages/FileViewer.jsx";
import { AgentViewer } from "./messages/AgentViewer.jsx";
import { Islands } from "./islands/Islands.jsx";
import { IslandHandle } from "./islands/IslandHandle.jsx";
import { AgentContextMenu } from "./popovers/AgentContextMenu.jsx";

// Latched once workers first load so returning to the Code tab does not replay
// the initial fade-in.
let everReady = false;

export function CodeView({ live }) {
  const ui = useUi();

  // Cmd+T → new empty session (mirrors the + button).
  useEffect(() => {
    const onKey = (e) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "t" && e.key !== "T") return;
      e.preventDefault();
      ui.setSelectedId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ui.setSelectedId]);

  // Clear selection if the selected worker no longer exists. Leaving
  // selectedId null is intentional (user pressed +, or first launch) and
  // must not auto-fallback to another orchestrator. Skip when workers is
  // empty — it can't tell "not loaded yet" from "no workers", and clearing
  // a persisted selection during the initial fetch would lose it.
  useEffect(() => {
    if (!ui.selectedId) return;
    if (live.workers.length === 0) return;
    const exists = live.workers.some((w) => w.id === ui.selectedId);
    if (!exists) ui.setSelectedId(null);
  }, [ui.selectedId, live.workers, ui.setSelectedId]);

  // Seed unseen workers + mark the selected one as viewed in a single pass.
  useEffect(() => {
    for (const w of live.workers) {
      ui.seedViewed(w);
      if (w.id === ui.selectedId) ui.markViewed(w);
    }
  }, [live.workers, ui.selectedId, ui.seedViewed, ui.markViewed]);

  useEffect(() => {
    ui.registerEscapeIdle(() => {
      const w = live.workers.find((x) => x.id === ui.selectedId);
      if (w && (w.state === "SPAWNING" || w.state === "WORKING")) {
        live.interruptAgent(w.id);
        ui.clearQueuedMessages(w.id);
      }
    });
  }, [ui.selectedId, live.workers, live.interruptAgent, ui.registerEscapeIdle, ui.clearQueuedMessages]);

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

  const [ready, setReady] = useState(everReady);
  useEffect(() => {
    if (ready || live.workers.length === 0) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { everReady = true; setReady(true); }));
  }, [ready, live.workers.length]);

  const selectedWorker = live.workers.find((w) => w.id === ui.selectedId);
  const panelOpen = ui.fileViewer || ui.agentViewer;
  const islandsVisible = !!selectedWorker && !ui.islandsHidden && !panelOpen;

  const gridClass = [
    ready ? "ready" : "",
    islandsVisible ? "has-islands" : "",
    ui.fileViewer ? "file-open" : "",
    ui.agentViewer ? "agent-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <AppLayout
      gridClass={gridClass}
      collapsedPopup={<SidePopup live={live} />}
      sidebar={<Sidebar live={live} />}
      main={
        <>
          <CenterHeader live={live} />
          <Messages live={live} />
          <Composer live={live} />
        </>
      }
      rightPanel={
        <>
          <FileViewer />
          <AgentViewer />
        </>
      }
    >
      <SideHandle live={live} />
      {!panelOpen && <Islands live={live} />}
      {!panelOpen && <IslandHandle />}
      <AgentContextMenu live={live} />
    </AppLayout>
  );
}
