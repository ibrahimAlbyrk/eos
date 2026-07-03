import { Fragment, useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { breadcrumbFor } from "../../../lib/breadcrumb.js";
import { statusFromState } from "../../../lib/format.js";
import { nameOf, AgentName } from "../../../lib/agentName.js";
import { RenameInput } from "../../../components/RenameInput.jsx";
import { api } from "../../../api/client.js";
import { HeaderAgentMenu } from "../popovers/HeaderAgentMenu.jsx";
import { TerminalToggleButton } from "../center/TerminalToggleButton.jsx";
import { SplitEmptyButton } from "../center/SplitEmptyButton.jsx";

// Per-pane top bar. Owned by each pane and rendered INSIDE its
// PaneScopeContext.Provider, so every scoped ui read/action (openPop, terminal
// toggle) targets THIS pane with no prop-drilling. The breadcrumb + rename +
// agent menu are keyed off the pane's OWN agent, not the focused selection — so
// each pane shows its own chain in split view. dragProps (from PaneGrid) carry
// the drag-to-reposition wiring onto the root; the single-pane view omits them.
export function PaneHeader({ worker, live, attention, needsInput, canClose, onClose, dragProps, newSession }) {
  const ui = useUi();
  // Header-local rename (breadcrumb inline edit), reset when the pane's agent
  // changes so a stale editor never carries over to a different worker.
  const [renaming, setRenaming] = useState(false);
  useEffect(() => { setRenaming(false); }, [worker?.id]);

  const status = worker ? statusFromState(worker.state) : null;

  // No agent: the single-pane new-session state shows the "new orchestrator"
  // breadcrumb (+ split); a split empty pane keeps today's hover-to-pick hint.
  if (!worker) {
    if (newSession) {
      const { project } = breadcrumbFor(live.workers, null, ui.composer.cwd);
      return (
        <div className="pane-head" {...dragProps}>
          <div className="crumb">
            <span className="scope">{project}</span>
            <span className="sep">/</span>
            <span className="cur">new orchestrator</span>
          </div>
          <div className="pane-head-actions">
            <SplitEmptyButton />
          </div>
        </div>
      );
    }
    return (
      <div className="pane-head" {...dragProps}>
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
    <div className="pane-head" {...dragProps}>
      {status && <span className={`ag-dot ${status.dot}`} />}
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
        <span className="v-wrap">
          <button className="v" data-popover-trigger="head-menu" onClick={toggleMenu} aria-label="Agent menu">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
          <HeaderAgentMenu live={live} agent={worker} onRename={startRename} />
        </span>
      </div>
      {needsInput
        ? <span className="pane-input-label" title="Needs your input — click the pane to answer">needs input</span>
        : attention
          ? <span className="ag-notify" aria-label="finished with new output" title="finished with new output" />
          : <span className="pane-status">{status.label}</span>}
      <div className="pane-head-actions">
        <TerminalToggleButton />
        <SplitEmptyButton />
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
