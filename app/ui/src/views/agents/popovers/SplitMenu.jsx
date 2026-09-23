import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { fanoutLayout, fillAgents, leaves } from "../../../lib/paneLayout.js";
import { isRunning } from "../../../lib/agentActivity.js";
import { useLayoutGroups, setActiveGroup } from "../../../state/layoutGroupsStore.js";

// Header "Split" menu (charcoal-aurora): Follow orchestrator children (fan the
// orchestrator's running children into a split — same fanoutLayout the agent
// context menu uses), Open empty split (⌃⌘T), and the saved layout groups
// (layoutGroupsStore). Portal'd to <body> at the header's bottom-right; anchor is
// the pane-head-actions cluster (in place it is clipped by the pane's
// contain:paint, HeaderAgentMenu idiom). Wrapper/inner split (ModelEffortPanel
// idiom) so the store subscription only runs while the menu is open.
export function SplitMenu({ live, worker, anchor }) {
  const ui = useUi();
  if (ui.openPopover !== "pane-menu") return null;
  return <SplitMenuInner ui={ui} live={live} worker={worker} anchor={anchor} />;
}

function SplitMenuInner({ ui, live, worker, anchor }) {
  const { groups, activeGroupId } = useLayoutGroups();
  const rect = anchor?.current?.getBoundingClientRect();
  if (!rect) return null;
  const pos = { top: Math.round(rect.bottom + 26), right: Math.max(8, Math.round(window.innerWidth - rect.right)) };

  const children = worker ? live.workers.filter((w) => w.parent_id === worker.id) : [];
  const running = children.filter(isRunning);
  const childIds = (running.length > 0 ? running : children).map((w) => w.id);
  const canFanout = Boolean(worker?.is_orchestrator) && children.length > 0;
  // No persistent "follow" flag in the app — mark it active when a live split is
  // showing and no saved layout owns the current arrangement.
  const following = canFanout && ui.paneCount > 1 && !activeGroupId;

  const followChildren = () => {
    if (!canFanout) return;
    ui.setLayout(fanoutLayout(worker.id, childIds));
    ui.closeAllPops();
  };
  const openEmpty = () => { ui.openEmptySplit(); ui.closeAllPops(); };
  const applyGroup = (g) => {
    const aliveIds = new Set(live.workers.map((w) => w.id));
    const resolved = leaves(g.tree).map((l) => (l.agentId != null && aliveIds.has(l.agentId) ? l.agentId : null));
    ui.setLayout(fillAgents(g.tree, resolved));
    setActiveGroup(g.id);
    ui.closeAllPops();
  };

  return createPortal(
    <div className="split-menu" data-popover="pane-menu" style={pos}>
      <button className="menu-item" onClick={followChildren} disabled={!canFanout}>
        <LayoutColsIcon />
        <span className="sm-label">Follow orchestrator children</span>
        <span className={"sm-check" + (following ? " on" : "")}><CheckIcon /></span>
      </button>
      <button className="menu-item" onClick={openEmpty}>
        <SplitIcon />
        <span className="sm-label">Open empty split</span>
        <span className="kbd">⌃⌘T</span>
      </button>
      <div className="menu-sep" />
      <div className="sm-sec">Saved layouts</div>
      {groups.length === 0 ? (
        <div className="sm-empty">No saved layouts</div>
      ) : (
        groups.map((g) => (
          <button key={g.id} className={"menu-item" + (g.id === activeGroupId ? " on" : "")} onClick={() => applyGroup(g)}>
            <LayoutColsIcon />
            <span className="sm-label">{g.name}</span>
          </button>
        ))
      )}
    </div>,
    document.body,
  );
}

function LayoutColsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2" y="2" width="5" height="12" rx="1" />
      <rect x="9" y="2" width="5" height="5.5" rx="1" />
      <rect x="9" y="8.5" width="5" height="5.5" rx="1" />
    </svg>
  );
}
function SplitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <line x1="8" y1="3" x2="8" y2="13" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 8.5 3.5 3.5L13 5" />
    </svg>
  );
}
