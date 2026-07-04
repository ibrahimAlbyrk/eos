import { Fragment, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { breadcrumbFor } from "../../../lib/breadcrumb.js";
import { nameOf, AgentName } from "../../../lib/agentName.js";
import { RenameInput } from "../../../components/RenameInput.jsx";
import { api } from "../../../api/client.js";
import { HeaderAgentMenu } from "../popovers/HeaderAgentMenu.jsx";
import { TerminalToggleButton } from "../center/TerminalToggleButton.jsx";

// Per-pane top bar: breadcrumb + agent menu on the left, terminal toggle on the
// right. Owned by each pane and rendered INSIDE its PaneScopeContext.Provider, so
// every scoped ui read/action (openPop, terminal toggle) targets THIS pane with
// no prop-drilling. The breadcrumb + rename + agent menu are keyed off the
// pane's OWN agent, not the focused selection — so each pane shows its own
// chain in split view. dragProps (from PaneGrid) carry the drag-to-reposition
// wiring onto the root; the single-pane view omits them. `split` adds the only
// extras the old mini pane-head had over the global bar: the status dot/label
// (or needs-input / attention cue) and the close button — never shown at N=1.
export function PaneHeader({ worker, live, attention, needsInput, canClose, onClose, dragProps, newSession, topLeft, topRow, split }) {
  const ui = useUi();
  // Header-local rename (breadcrumb inline edit), reset when the pane's agent
  // changes so a stale editor never carries over to a different worker.
  const [renaming, setRenaming] = useState(false);
  useEffect(() => { setRenaming(false); }, [worker?.id]);
  // Anchor for the portal'd agent menu (see HeaderAgentMenu): the crumb clips
  // (overflow:hidden) and split panes paint-contain, so the menu can't render
  // in place — it measures this wrap and portals to <body> instead.
  const vWrapRef = useRef(null);

  // The top-left pane (rect touches 0,0) is the one under the native window chrome
  // once the strip is gone. When the sidebar is collapsed its header reserves a
  // left inset (CSS) so the breadcrumb clears the traffic lights + sidebar toggle;
  // that inset zone is also the window-drag region (data-window-drag opts it back
  // into --app-region: drag, and out of the pane-move arming in PaneGrid).
  // --toprow: split panes on the grid's top row compensate the island chrome
  // above them so the bar content sits at the N=1 window-y (see styles.css).
  const rootClass = ["pane-head", topRow ? "pane-head--toprow" : "", topLeft ? "pane-head--topleft" : ""]
    .filter(Boolean)
    .join(" ");
  const insetEl = topLeft ? <span className="pane-head-inset" data-window-drag aria-hidden="true" /> : null;

  // No agent: the single-pane new-session state shows the "new orchestrator"
  // breadcrumb; a split empty pane keeps today's hover-to-pick hint.
  if (!worker) {
    if (newSession) {
      const { project } = breadcrumbFor(live.workers, null, ui.composer.cwd);
      return (
        <div className={rootClass} {...dragProps}>
          {insetEl}
          <div className="crumb">
            <span className="scope">{project}</span>
            <span className="sep">/</span>
            <span className="cur">new orchestrator</span>
          </div>
          <div className="pane-head-actions">
            <TerminalToggleButton />
          </div>
        </div>
      );
    }
    return (
      <div className={rootClass} {...dragProps}>
        {insetEl}
        <span className="pane-name">Empty — hover to pick an agent</span>
        {canClose && <CloseButton onClose={onClose} />}
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
    <div className={rootClass} {...dragProps}>
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
          <button className="v" data-popover-trigger="head-menu" onClick={toggleMenu} aria-label="Agent menu">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
          <HeaderAgentMenu live={live} agent={worker} onRename={startRename} anchor={vWrapRef} />
        </span>
      </div>
      {split && (needsInput
        ? <span className="pane-input-label" title="Needs your input — click the pane to answer">needs input</span>
        : attention
          ? <span className="ag-notify" aria-label="finished with new output" title="finished with new output" />
          : null)}
      <div className="pane-head-actions">
        <TerminalToggleButton />
        {canClose && <CloseButton onClose={onClose} />}
      </div>
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
