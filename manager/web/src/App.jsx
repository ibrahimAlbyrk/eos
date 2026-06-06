import { useEffect } from "react";
import { useUi, UiProvider, useAttentionSync } from "./state/ui.jsx";
import { useLive } from "./hooks/useLive.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { CommandPalette } from "./components/search/CommandPalette.jsx";
import { SettingsModal } from "./components/settings/SettingsModal.jsx";
import { getViewComponent } from "./views/registry.js";

function Shell() {
  const ui = useUi();
  const live = useLive();

  // Attention bookkeeping runs here, not in a view, so the sidebar dot
  // state stays correct while other tabs are active.
  useAttentionSync(live.workers, ui.selectedId);

  // Native app notification tap → jump to the Code tab and select the worker.
  useEffect(() => {
    window.__nativeNavigate = (id) => { ui.setActiveView("code"); ui.setSelectedId(id); };
    return () => { delete window.__nativeNavigate; };
  }, [ui.setActiveView, ui.setSelectedId]);

  const ActiveView = getViewComponent(ui.activeViewId);
  return (
    <>
      <ActiveView live={live} />
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
