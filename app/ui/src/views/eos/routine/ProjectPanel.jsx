import { useMemo } from "react";
import { useUi } from "../../../state/ui.jsx";
import { PaneScopeContext } from "../../../state/paneScope.js";
import { PanelHostContext } from "../../../state/panelHost.js";
import { SidePanel } from "../../agents/panes/SidePanel.jsx";

function Toggle() {
  const ui = useUi();
  return (
    <button type="button" className="eos-btn eos-project__toggle" aria-pressed={ui.showSidePanel} onClick={() => ui.toggleSidePanel()}>
      {ui.showSidePanel ? "Hide the side panel" : "Side panel"}
    </button>
  );
}

// A project's side panel (08 §5, SurfaceApp): the Agents side panel with the
// "eos" launcher, its own pane scope `eos:<routineId>`, working in the
// project's folder when that is a path here.
export function ProjectPanel({ routineId, repo }) {
  const host = useMemo(() => ({ key: `eos:${routineId}`, cwd: repo?.startsWith("/") ? repo : null }), [routineId, repo]);
  return (
    <PaneScopeContext.Provider value={host.key}>
      <PanelHostContext.Provider value={host}>
        <Toggle />
        <div className="eos-project__panel sp-host is-panel-open">
          <SidePanel surface="eos" />
        </div>
      </PanelHostContext.Provider>
    </PaneScopeContext.Provider>
  );
}
