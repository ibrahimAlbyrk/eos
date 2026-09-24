import { useEffect, useState } from "react";
import { useUi, UiProvider, useAttentionSync } from "./state/ui.jsx";
import { useLive } from "./hooks/useLive.js";
import { useStorePrune } from "./hooks/useStorePrune.js";
import { useViewSwitchHotkeys } from "./hooks/useViewSwitchHotkeys.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { CommandPalette } from "./components/search/CommandPalette.jsx";
import { SettingsModal } from "./components/settings/SettingsModal.jsx";
import { ProjectModalHost } from "./components/project/ProjectModal.jsx";
import { MonitorWidget } from "./components/monitor/MonitorWidget.jsx";
import { NativeToggleZone } from "./components/layout/NativeToggleZone.jsx";
import { SideHandle } from "./components/layout/SideHandle.jsx";
import { SidebarPopup } from "./components/layout/SidebarPopup.jsx";
import { getViewComponent, getViewSidebar, keepsMounted } from "./views/registry.js";

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

  // Cmd+Ctrl+1/2 → Agents / Code.
  useViewSwitchHotkeys();

  // Panel-level attention for the collapsed-sidebar expand button pip.
  const hasAttention = ui.anyNeedsAttention(live.workers);

  // Native app notification tap → jump to the Code tab and select the worker.
  useEffect(() => {
    window.__nativeNavigate = (id) => { ui.setActiveView("agents"); ui.setSelectedId(id); };
    return () => { delete window.__nativeNavigate; };
  }, [ui.setActiveView, ui.setSelectedId]);

  // Recall (interrupt before the agent responded) is consumed directly by the
  // pane's Composer that owns recall.workerId (recallStore) — no selectedId-keyed
  // derivation here, so nothing re-injects on re-render, reselect, or reconnect.

  const ActiveView = getViewComponent(ui.activeViewId);

  // Keep-mounted views opened so far; they stay rendered (hidden) after the user
  // switches away. Adjusting state during render is React's derive-from-props idiom.
  const [keptIds, setKeptIds] = useState([]);
  if (keepsMounted(ui.activeViewId) && !keptIds.includes(ui.activeViewId)) {
    setKeptIds([...keptIds, ui.activeViewId]);
  }

  // Shell chrome (collapsed-rail handle + native toggle + hover flyout) lives
  // here, not inside the per-view AppLayout, so it stays mounted across view
  // switches and the flyout no longer remounts/flickers. Only the flyout's
  // contents swap, via the active view's registered sidebar.
  const Sidebar = getViewSidebar(ui.activeViewId);
  const popup = <SidebarPopup><Sidebar live={live} variant="popup" /></SidebarPopup>;

  return (
    <>
      {!keepsMounted(ui.activeViewId) && <ActiveView live={live} />}
      {keptIds.map((id) => {
        const View = getViewComponent(id);
        return <View key={id} live={live} active={id === ui.activeViewId} />;
      })}
      <NativeToggleZone popup={popup} hasAttention={hasAttention} />
      <SideHandle popup={popup} hasAttention={hasAttention} />
      <CommandPalette live={live} />
      <MonitorWidget live={live} />
      <SettingsModal />
      <ProjectModalHost />
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
