import { useEffect } from "react";
import { useUi, UiProvider } from "./state/ui.jsx";
import { useLive } from "./hooks/useLive.js";
import { useWebNotifications } from "./hooks/useWebNotifications.js";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { getViewComponent } from "./views/registry.js";

function Shell() {
  const ui = useUi();
  const live = useLive();

  useWebNotifications();

  // Native app notification tap → jump to the Code tab and select the worker.
  useEffect(() => {
    window.__nativeNavigate = (id) => { ui.setActiveView("code"); ui.setSelectedId(id); };
    return () => { delete window.__nativeNavigate; };
  }, [ui.setActiveView, ui.setSelectedId]);

  const ActiveView = getViewComponent(ui.activeViewId);
  return <ActiveView live={live} />;
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
