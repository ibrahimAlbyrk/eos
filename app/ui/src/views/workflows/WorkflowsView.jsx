import { useCallback, useRef, useState } from "react";
import { AppLayout } from "../../components/layout/AppLayout.jsx";
import { TabBar } from "../../components/TabBar.jsx";
import { SettingsFooter } from "../../components/SettingsFooter.jsx";
import { WorkflowEditor } from "./editor/WorkflowEditor.jsx";
import { WorkflowSubTabs } from "./WorkflowSubTabs.jsx";
import { LibraryView } from "./management/LibraryView.jsx";
import { RunsView } from "./runs/RunsView.jsx";
import { WorkflowSidebarSlotContext } from "./sidebarSlot.jsx";

const SUB_TABS = [
  { id: "editor", label: "Editor" },
  { id: "library", label: "Library" },
  { id: "runs", label: "Runs" },
];

// `slotRef` is set only on the full sidebar (rendered by AppLayout). It marks the
// region under the switcher into which the active tab portals its palette/list;
// the popup (collapsed-hover) sidebar omits it, so there is one slot at a time.
export function WorkflowsSidebar({ variant, view, onChange, slotRef }) {
  const body = (
    <>
      <TabBar variant={variant} />
      <div className="sb-head">
        <div className="sb-head__title">Workflows</div>
      </div>
      <WorkflowSubTabs tabs={SUB_TABS} active={view} onChange={onChange} />
      {slotRef && <div className="wf-sb-slot" ref={slotRef} />}
      <SettingsFooter />
    </>
  );

  if (variant === "popup") return body;

  return <div className="side-island side-island--agents">{body}</div>;
}

function WorkflowsMain({ view, loadReq, openInEditor }) {
  return (
    <div className="wf-host">
      <div className="wf-views">
        {/* The editor stays mounted across switches so unsaved work + viewport
            survive; it portals its palette into the sidebar only while active. */}
        <div className="wf-view" style={{ display: view === "editor" ? "flex" : "none" }}>
          <WorkflowEditor loadReq={loadReq} active={view === "editor"} />
        </div>
        {/* Library/Runs mount only while active, so each portals its sidebar list
            on entry and tears it down (Runs' SSE included) on leave. */}
        {view === "library" && (
          <div className="wf-view">
            <LibraryView onOpenInEditor={openInEditor} />
          </div>
        )}
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
  const [view, setView] = useState("editor");
  const [loadReq, setLoadReq] = useState(null);
  const [slotEl, setSlotEl] = useState(null);
  const nonce = useRef(0);

  // Library → Editor handoff: stamp a fresh nonce so the editor reloads even when
  // re-opening the same definition, then switch to the Editor tab. `readOnly` opens
  // the editor in view-only mode (read-only-provenance graphs).
  const openInEditor = useCallback((doc, { readOnly = false } = {}) => {
    nonce.current += 1;
    setLoadReq({ doc, nonce: nonce.current, readOnly });
    setView("editor");
  }, []);

  return (
    <WorkflowSidebarSlotContext.Provider value={slotEl}>
      <AppLayout
        sidebar={(variant) => <WorkflowsSidebar variant={variant} view={view} onChange={setView} slotRef={setSlotEl} />}
        main={<WorkflowsMain view={view} loadReq={loadReq} openInEditor={openInEditor} />}
      />
    </WorkflowSidebarSlotContext.Provider>
  );
}
