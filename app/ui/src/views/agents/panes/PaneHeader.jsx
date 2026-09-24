import { Fragment, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { breadcrumbFor, newSessionProject } from "../../../lib/breadcrumb.js";
import { nameOf, AgentName } from "../../../lib/agentName.js";
import { RenameInput } from "../../../components/RenameInput.jsx";
import { api } from "../../../api/client.js";
import { HeaderAgentMenu } from "../popovers/HeaderAgentMenu.jsx";
import { SplitMenu } from "../popovers/SplitMenu.jsx";
import { toggleEnvPanel, useEnvPanelOpen } from "../../../state/envPanelStore.js";
import { PlanChip } from "./PlanChip.jsx";

// Per-pane top bar: breadcrumb + agent menu on the left, and — on the right —
// exactly the reference's three chrome buttons: Environment & changes (git
// docked panel), Split (layout menu, single/primary header only), and a slot for
// the Open-side-panel toggle (drawn by SidePanel as a pane overlay).
// Owned by each pane and rendered INSIDE its PaneScopeContext.Provider, so every
// scoped ui read/action (openPop, toggleSidePanel) targets THIS pane with no
// prop-drilling. The header is the native window-drag strip (--app-region: drag
// in CSS); its buttons/inputs opt back out. `split` adds the split-pane extras
// (status/attention cue + close ×) and drops the Split-menu button (a split pane
// can't re-split from its own header — reference). Collapsed-sidebar chrome
// (traffic lights + hamburger) is drawn by the shell's SideHandle/NativeToggleZone
// overlays that sit over `.pane-head-inset`; see App.jsx.
export function PaneHeader({ worker, live, attention, needsInput, canClose, onClose, topLeft, topRow, split }) {
  const ui = useUi();
  // Header-local rename (breadcrumb inline edit), reset when the pane's agent
  // changes so a stale editor never carries over to a different worker.
  const [renaming, setRenaming] = useState(false);
  useEffect(() => { setRenaming(false); }, [worker?.id]);
  // Anchor for the portal'd agent menu (see HeaderAgentMenu): the crumb clips
  // (overflow:hidden) and split panes paint-contain, so the menu can't render
  // in place — it measures this wrap and portals to <body> instead.
  const vWrapRef = useRef(null);
  // Anchor for the portal'd Split popover — it measures this
  // button cluster and drops from the header's bottom line, right-aligned.
  const actionsRef = useRef(null);
  const envOpen = useEnvPanelOpen(ui.paneId);

  const rootClass = ["pane-head", topRow ? "pane-head--toprow" : "", topLeft ? "pane-head--topleft" : ""]
    .filter(Boolean)
    .join(" ");
  const insetEl = topLeft ? <span className="pane-head-inset" aria-hidden="true" /> : null;

  const togglePop = (id, e) => {
    e.stopPropagation();
    if (ui.openPopover === id) ui.closeAllPops();
    else ui.openPop(id);
  };

  // Right-side actions. worker headers: Environment · (Split when not split) ·
  // Open side panel; no-agent header: inert Environment · Open side panel (the
  // reference new-task header shows the checklist icon decoratively — no worker,
  // nothing to open). × closes non-primary split panes.
  const actions = (
    <div className="pane-head-actions" ref={actionsRef}>
      {worker && (
        <button
          className={"pane-split-btn" + (envOpen ? " is-active" : "")}
          title="Environment & changes"
          aria-label="Environment & changes"
          onClick={(e) => { e.stopPropagation(); toggleEnvPanel(ui.paneId); }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
            <path d="M2.6 3.4 3.4 4.2 4.8 2.8" />
            <path d="M2.6 7.4 3.4 8.2 4.8 6.8" />
            <path d="M2.6 11.4 3.4 12.2 4.8 10.8" />
          </svg>
        </button>
      )}
      {worker && !split && (
        <button
          className={"pane-split-btn" + (ui.openPopover === "pane-menu" ? " is-active" : "")}
          title="Split"
          aria-label="Split layout"
          onClick={(e) => togglePop("pane-menu", e)}
          data-popover-trigger="pane-menu"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <line x1="8" y1="3" x2="8" y2="13" />
          </svg>
        </button>
      )}
      {!worker && (
        <span className="pane-split-btn pane-split-btn--inert" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <path d="M6.5 4h7M6.5 8h7M6.5 12h7" />
            <path d="M2.6 3.4 3.4 4.2 4.8 2.8" />
            <path d="M2.6 7.4 3.4 8.2 4.8 6.8" />
            <path d="M2.6 11.4 3.4 12.2 4.8 10.8" />
          </svg>
        </span>
      )}
      {/* The side-panel toggle is a pane-level overlay (SidePanel's
          SidePanelToggle) so it stays put while the panel slides open; this
          empty slot holds its spot in the row while the panel is closed. */}
      {!ui.showSidePanel && <span className="pane-split-btn" aria-hidden="true" />}
      {canClose && <CloseButton onClose={onClose} />}
      {worker && !split && <SplitMenu live={live} worker={worker} anchor={actionsRef} />}
    </div>
  );

  // No agent → the new-session state: the "new orchestrator" breadcrumb + the
  // reference new-task header's two icons (inert Environment + Open side panel).
  // The input bar lives in the pane body below (PaneGrid renders the Composer).
  if (!worker) {
    // Reference new-task header: "new orchestrator" (strong) + the faint project
    // name, which disappears entirely when no folder is set.
    const { project } = newSessionProject(ui.composer.cwd, live.recents);
    return (
      <div className={rootClass}>
        {insetEl}
        <div className="crumb">
          <span className="cur">new orchestrator</span>
          {project && <span className="scope">{project}</span>}
        </div>
        {actions}
      </div>
    );
  }

  const { project, chain } = breadcrumbFor(live.workers, worker.id, ui.composer.cwd);
  const menuOpen = ui.openPopover === "head-menu";
  const toggleMenu = () => (menuOpen ? ui.closeAllPops() : ui.openPop("head-menu"));
  const startRename = () => {
    setRenaming(true);
    api.renameIntent(worker.id, true).catch(() => {});
  };

  return (
    <div className={rootClass}>
      {insetEl}
      <div className="crumb">
        <span className="scope">{project}</span>
        {chain.map((seg, i) => {
          const isLast = i === chain.length - 1;
          return (
            <Fragment key={seg.id}>
              <span className="sep">/</span>
              {!isLast && (
                <button className="crumb-link" onClick={() => ui.setSelectedId(seg.id)}>
                  <AgentName worker={seg.worker} />
                </button>
              )}
              {isLast && (renaming ? (
                <RenameInput
                  currentName={nameOf(worker)}
                  onSave={(name) => { setRenaming(false); live.renameAgent(seg.id, name); }}
                  onCancel={() => setRenaming(false)}
                  workerId={seg.id}
                />
              ) : (
                <span className="cur"><AgentName worker={seg.worker} /></span>
              ))}
            </Fragment>
          );
        })}
        <span className="v-wrap" ref={vWrapRef}>
          <button className={`v${menuOpen ? " on" : ""}`} data-popover-trigger="head-menu" onClick={toggleMenu} aria-label="Agent menu">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
          <HeaderAgentMenu live={live} agent={worker} onRename={startRename} anchor={vWrapRef} />
        </span>
        <PlanChip worker={worker} />
      </div>
      {split && (needsInput
        ? <span className="pane-input-label" title="Needs your input — click the pane to answer">needs input</span>
        : attention
          ? <span className="ag-notify" aria-label="finished with new output" title="finished with new output" />
          : null)}
      {actions}
    </div>
  );
}

function CloseButton({ onClose }) {
  return (
    <button
      className="pane-close"
      title="Close pane"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  );
}
