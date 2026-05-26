import { useCallback, useEffect, useRef, useState } from "react";
import { UiProvider, useUi } from "./state/ui.jsx";
import { useLive } from "./hooks/useLive.js";
import { useWebNotifications } from "./hooks/useWebNotifications.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { Sidebar } from "./components/sidebar/Sidebar.jsx";
import { SideHandle } from "./components/sidebar/SideHandle.jsx";
import { SidePopup } from "./components/sidebar/SidePopup.jsx";
import { CenterHeader } from "./components/center/CenterHeader.jsx";
import { Messages } from "./components/messages/Messages.jsx";
import { Composer } from "./components/center/Composer.jsx";
import { Islands } from "./components/islands/Islands.jsx";
import { IslandHandle } from "./components/islands/IslandHandle.jsx";
import { AgentContextMenu } from "./components/popovers/AgentContextMenu.jsx";
import { FileViewer } from "./components/messages/FileViewer.jsx";

function Shell() {
  const ui = useUi();
  const live = useLive();

  useWebNotifications();

  // Native app notification tap → navigate to worker
  useEffect(() => {
    window.__nativeNavigate = (id) => ui.setSelectedId(id);
    return () => { delete window.__nativeNavigate; };
  }, [ui.setSelectedId]);

  // Auto-select first orchestrator if nothing valid is selected
  useEffect(() => {
    if (live.orchestrators.length === 0) return;
    const valid = ui.selectedId && live.workers.some((w) => w.id === ui.selectedId);
    if (!valid) ui.setSelectedId(live.orchestrators[0].id);
  }, [ui.selectedId, live.orchestrators, live.workers, ui.setSelectedId]);

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

  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready || live.workers.length === 0) return;
    requestAnimationFrame(() => requestAnimationFrame(() => setReady(true)));
  }, [ready, live.workers.length]);

  const cls = ["app"];
  if (ready) cls.push("ready");
  if (ui.sideCollapsed) cls.push("side-collapsed");
  const selectedWorker = live.workers.find((w) => w.id === ui.selectedId);
  const islandsVisible = !!selectedWorker && !ui.islandsHidden && !ui.fileViewer;
  if (islandsVisible) cls.push("has-islands");
  if (ui.fileViewer) cls.push("file-open");

  const [nativeHover, setNativeHover] = useState(false);
  const nativeLeaveTimer = useRef(null);
  const nativeInsideRef = useRef(false);
  const nativePopRef = useRef(ui.openPopover);
  nativePopRef.current = ui.openPopover;
  const nativeEnter = useCallback(() => {
    nativeInsideRef.current = true;
    clearTimeout(nativeLeaveTimer.current);
    if (ui.sideCollapsed) setNativeHover(true);
  }, [ui.sideCollapsed]);
  const nativeLeave = useCallback(() => {
    nativeInsideRef.current = false;
    nativeLeaveTimer.current = setTimeout(() => {
      if (!nativePopRef.current) setNativeHover(false);
    }, 200);
  }, []);
  useEffect(() => {
    if (!ui.openPopover && nativeHover && !nativeInsideRef.current) {
      nativeLeaveTimer.current = setTimeout(() => setNativeHover(false), 300);
    }
  }, [ui.openPopover, nativeHover]);

  return (
    <>
    <div
      className="native-toggle-zone"
      onMouseEnter={nativeEnter}
      onMouseLeave={nativeLeave}
    >
      <button
        className="native-toggle sb-iconbtn"
        onClick={() => { ui.setSideCollapsed(!ui.sideCollapsed); setNativeHover(false); }}
        title={ui.sideCollapsed ? "Show sidebar" : "Hide sidebar"}
      >
        {ui.sideCollapsed ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="4" x2="11" y2="4" />
            <line x1="3" y1="8" x2="13" y2="8" />
            <line x1="3" y1="12" x2="9" y2="12" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <line x1="6" y1="3" x2="6" y2="13" />
          </svg>
        )}
      </button>
      {nativeHover && ui.sideCollapsed && <SidePopup live={live} />}
    </div>
    <div className={cls.join(" ")}>
      <Sidebar live={live} />
      <SideHandle live={live} />

      <section className="center">
        <CenterHeader live={live} />
        <Messages live={live} />
        <Composer live={live} />
      </section>

      {!ui.fileViewer && <Islands live={live} />}
      {!ui.fileViewer && <IslandHandle />}
      <FileViewer />

      <AgentContextMenu live={live} />
    </div>
    </>
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
