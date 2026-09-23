import { useUi } from "../../../state/ui.jsx";
import { BranchManager } from "../popovers/BranchManager.jsx";
import { GitTray } from "./GitTray.jsx";
import { QueueTray } from "./QueueTray.jsx";

// The tray slot behind the composer card once a session exists: queued
// messages while there are any, else the git actions. Also hosts the Branch
// manager ("branch-dd") the header's Environment popover opens.
export function SessionTray({ live, worker, wtStatus, queued, onSteer, onEdit, onDismiss }) {
  const ui = useUi();
  const cwd = worker.cwd ?? worker.worktree_from ?? null;
  return (
    <div className="session-tray">
      {queued.length > 0 ? (
        <QueueTray items={queued} onSteer={onSteer} onEdit={onEdit} onDismiss={onDismiss} />
      ) : (
        <GitTray live={live} worker={worker} wtStatus={wtStatus} pinned={ui.openPopover === "branch-dd"} />
      )}
      <div className="c-strip-wrap session-tray-anchor">
        <BranchManager live={live} cwd={cwd} />
      </div>
    </div>
  );
}
