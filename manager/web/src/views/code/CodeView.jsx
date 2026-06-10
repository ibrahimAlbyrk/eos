import { useEffect, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { useAgentSwitchHotkeys } from "../../hooks/useAgentSwitchHotkeys.js";
import { useDeleteAgentHotkey } from "../../hooks/useDeleteAgentHotkey.js";
import { useGitModeHotkey } from "../../hooks/useGitModeHotkey.js";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { CodeSidebar } from "./sidebar/CodeSidebar.jsx";
import { CenterHeader } from "./center/CenterHeader.jsx";
import { Composer } from "./center/Composer.jsx";
import { Messages } from "./messages/Messages.jsx";
import { FileViewer } from "./messages/FileViewer.jsx";
import { AgentViewer } from "./messages/AgentViewer.jsx";
import { DiffViewer } from "./messages/DiffViewer.jsx";
import { CommitsViewer } from "./messages/CommitsViewer.jsx";
import { AgentContextMenu } from "./popovers/AgentContextMenu.jsx";
import { RewindPanel } from "./center/RewindPanel.jsx";

// Latched once workers first load so returning to the Code tab does not replay
// the initial fade-in.
let everReady = false;

export function CodeView({ live }) {
  const ui = useUi();

  // Cmd+1..9 → select Nth visible agent in the sidebar.
  useAgentSwitchHotkeys(live);

  // Cmd+W → delete the selected agent (falls back to the previous selection).
  useDeleteAgentHotkey(live);

  // Cmd+G → toggle the composer's git custom-task mode.
  useGitModeHotkey();

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

  const [ready, setReady] = useState(everReady);
  useEffect(() => {
    if (ready || live.workers.length === 0) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { everReady = true; setReady(true); }));
  }, [ready, live.workers.length]);

  // Grid sizing follows the VISIBLE (top) panel — buried panels stay mounted
  // but must not claim the column.
  const gridClass = [
    ready ? "ready" : "",
    ui.topPanelType === "file" ? "file-open" : "",
    ui.topPanelType === "agent" ? "agent-open" : "",
    ui.topPanelType === "diff" ? "diff-open" : "",
    ui.topPanelType === "commits" ? "commits-open" : "",
  ].filter(Boolean).join(" ");

  return (
    <AppLayout
      gridClass={gridClass}
      sidebar={(variant) => <CodeSidebar live={live} variant={variant} />}
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
          <DiffViewer live={live} />
          <CommitsViewer />
        </>
      }
    >
      <AgentContextMenu live={live} />
      {ui.rewindPanel && <RewindPanel live={live} />}
    </AppLayout>
  );
}
