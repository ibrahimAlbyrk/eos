import { useEffect } from "react";
import { useUi, UiProvider, useAttentionSync } from "./state/ui.jsx";
import { useLive } from "./hooks/useLive.js";
import { useStorePrune } from "./hooks/useStorePrune.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { CommandPalette } from "./components/search/CommandPalette.jsx";
import { SettingsModal } from "./components/settings/SettingsModal.jsx";
import { MonitorWidget } from "./components/monitor/MonitorWidget.jsx";
import { NativeToggleZone } from "./components/layout/NativeToggleZone.jsx";
import { SideHandle } from "./components/layout/SideHandle.jsx";
import { SidebarPopup } from "./components/layout/SidebarPopup.jsx";
import { ToastViewport } from "./components/toast/ToastViewport.jsx";
import { getViewComponent, getViewSidebar } from "./views/registry.js";

function Shell() {
  const ui = useUi();
  const live = useLive();

  // Attention bookkeeping runs here, not in a view, so the sidebar dot
  // state stays correct while other tabs are active.
  useAttentionSync(live.workers, ui.selectedId);

  // Drop per-worker caches for workers that left the live list (auto-shutdown,
  // cascade death, daemon-restart disappearance) — the explicit-delete purge
  // can't catch those.
  useStorePrune(live.workers);

  // Panel-level attention for the collapsed-sidebar expand button pip.
  const hasAttention = ui.anyNeedsAttention(live.workers);

  // Native app notification tap → jump to the Code tab and select the worker.
  useEffect(() => {
    window.__nativeNavigate = (id) => { ui.setActiveView("code"); ui.setSelectedId(id); };
    return () => { delete window.__nativeNavigate; };
  }, [ui.setActiveView, ui.setSelectedId]);

  // Recall (interrupt before the agent responded) is consumed directly by the
  // pane's Composer that owns recall.workerId (recallStore) — no selectedId-keyed
  // derivation here, so nothing re-injects on re-render, reselect, or reconnect.

  const ActiveView = getViewComponent(ui.activeViewId);

  // Shell chrome (collapsed-rail handle + native toggle + hover flyout) lives
  // here, not inside the per-view AppLayout, so it stays mounted across view
  // switches and the flyout no longer remounts/flickers. Only the flyout's
  // contents swap, via the active view's registered sidebar.
  const Sidebar = getViewSidebar(ui.activeViewId);
  const popup = <SidebarPopup><Sidebar live={live} variant="popup" /></SidebarPopup>;

  return (
    <>
      <ActiveView live={live} />
      <NativeToggleZone popup={popup} hasAttention={hasAttention} />
      <SideHandle popup={popup} hasAttention={hasAttention} />
      <CommandPalette live={live} />
      <MonitorWidget live={live} />
      <SettingsModal />
      <ToastViewport />
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
