import { useCallback, useRef, useState } from "react";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { TabBar } from "../../components/TabBar.jsx";
import { SettingsFooter } from "../../components/SettingsFooter.jsx";
import { WorkflowEditor } from "./editor/WorkflowEditor.jsx";
import { WorkflowSubTabs } from "./WorkflowSubTabs.jsx";
import { LibraryView } from "./management/LibraryView.jsx";
import { RunsView } from "./runs/RunsView.jsx";

export function WorkflowsSidebar({ variant }) {
  const body = (
    <>
      <TabBar variant={variant} />
      <div className="sb-head">
        <div className="sb-head__title">Workflows</div>
      </div>
      <SettingsFooter />
    </>
  );

  if (variant === "popup") return body;

  return <div className="side-island side-island--agents">{body}</div>;
}

const SUB_TABS = [
  { id: "editor", label: "Editor" },
  { id: "library", label: "Library" },
  { id: "runs", label: "Runs" },
];

function WorkflowsMain() {
  const [view, setView] = useState("editor");
  const [loadReq, setLoadReq] = useState(null);
  const nonce = useRef(0);

  // Library → Editor handoff: stamp a fresh nonce so the editor reloads even when
  // re-opening the same definition, then switch to the Editor tab.
  const openInEditor = useCallback((doc) => {
    nonce.current += 1;
    setLoadReq({ doc, nonce: nonce.current });
    setView("editor");
  }, []);

  return (
    <div className="wf-host">
      <WorkflowSubTabs tabs={SUB_TABS} active={view} onChange={setView} />
      <div className="wf-views">
        {/* The editor stays mounted across switches so unsaved work + viewport
            survive; Library is mounted only while active so it re-fetches on entry. */}
        <div className="wf-view" style={{ display: view === "editor" ? "flex" : "none" }}>
          <WorkflowEditor loadReq={loadReq} />
        </div>
        {view === "library" && (
          <div className="wf-view">
            <LibraryView onOpenInEditor={openInEditor} />
          </div>
        )}
        {/* Runs is mounted only while active so its SSE streams open on entry and
            tear down on leave. */}
        {view === "runs" && (
          <div className="wf-view">
            <RunsView />
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowsView() {
  return (
    <AppLayout
      sidebar={(variant) => <WorkflowsSidebar variant={variant} />}
      main={<WorkflowsMain />}
    />
  );
}
