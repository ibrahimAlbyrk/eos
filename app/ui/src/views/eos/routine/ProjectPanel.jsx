import { useEffect, useMemo, useRef } from "react";
import { surfaceAppTabId } from "../../../lib/panelTabs.js";
import { loadRoutineApp, usePages } from "../../../state/eos/pageStore.js";
import { useUi } from "../../../state/ui.jsx";
import "../surface/registerSurfacePanel.js";
import { PaneScopeContext } from "../../../state/paneScope.js";
import { PanelHostContext } from "../../../state/panelHost.js";
import { SidePanel } from "../../agents/panes/SidePanel.jsx";

function Toggle() {
  const ui = useUi();
  return (
    <button type="button" className="eos-btn eos-btn--quiet eos-project__toggle" aria-pressed={ui.showSidePanel} aria-label={ui.showSidePanel ? "Hide the side panel" : "Show the side panel"} onClick={() => ui.toggleSidePanel()}>
      {ui.showSidePanel ? "Hide" : "Show"}
    </button>
  );
}

// The routine's App opens in its own tab once it is in use: only after its
// review and its tests passed and the user kept it.
function OpenApp({ routineId }) {
  const ui = useUi();
  const { appByRoutine } = usePages();
  const opened = useRef(null);
  const appId = appByRoutine[routineId];
  useEffect(() => { void loadRoutineApp(routineId); }, [routineId]);
  useEffect(() => {
    if (!appId || opened.current === appId) return;
    opened.current = appId;
    ui.openPanel(surfaceAppTabId(appId));
  }, [appId, ui]);
  return null;
}

// A project's side panel (08 §5, SurfaceApp): the Agents side panel with the
// "eos" launcher, its own pane scope `eos:<routineId>`, working in the
// project's folder when that is a path here.
export function ProjectPanel({ routineId, repo }) {
  const host = useMemo(() => ({ key: `eos:${routineId}`, cwd: repo?.startsWith("/") ? repo : null }), [routineId, repo]);
  return (
    <PaneScopeContext.Provider value={host.key}>
      <PanelHostContext.Provider value={host}>
        <div className="eos-section__head eos-project__head">
          <h2 className="eos-label">Side panel</h2>
          <Toggle />
        </div>
        <OpenApp routineId={routineId} />
        <div className="eos-project__panel sp-host is-panel-open">
          <SidePanel surface="eos" />
        </div>
      </PanelHostContext.Provider>
    </PaneScopeContext.Provider>
  );
}
