import { useEffect } from "react";
import { useUi, UiProvider, useAttentionSync } from "./state/ui.jsx";
import { useLive } from "./hooks/useLive.js";
import { useUiFreshness } from "./hooks/useUiFreshness.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { CommandPalette } from "./components/search/CommandPalette.jsx";
import { SettingsModal } from "./components/settings/SettingsModal.jsx";
import { NativeToggleZone } from "./components/layout/NativeToggleZone.jsx";
import { SideHandle } from "./components/layout/SideHandle.jsx";
import { SidebarPopup } from "./components/layout/SidebarPopup.jsx";
import { getViewComponent, getViewSidebar } from "./views/registry.js";

function Shell() {
  const ui = useUi();
  const live = useLive();

  // Attention bookkeeping runs here, not in a view, so the sidebar dot
  // state stays correct while other tabs are active.
  useAttentionSync(live.workers, ui.selectedId);

  // Reload once if dist was rebuilt under this page (vite watch / missed
  // ui:reload) — stale bundles otherwise run until the app is relaunched.
  useUiFreshness();

  // Panel-level attention for the collapsed-sidebar expand button pip.
  const hasAttention = ui.anyNeedsAttention(live.workers);

  // Native app notification tap → jump to the Code tab and select the worker.
  useEffect(() => {
    window.__nativeNavigate = (id) => { ui.setActiveView("code"); ui.setSelectedId(id); };
    return () => { delete window.__nativeNavigate; };
  }, [ui.setActiveView, ui.setSelectedId]);

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
      <SettingsModal />
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
