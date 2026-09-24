import { GitTray } from "./GitTray.jsx";
import { QueueTray } from "./QueueTray.jsx";

// The tray slot behind the composer card once a session exists: queued
// messages while there are any, else the git actions.
export function SessionTray({ live, worker, wtStatus, queued, onSteer, onEdit, onDismiss }) {
  return (
    <div className="session-tray">
      {queued.length > 0 ? (
        <QueueTray items={queued} onSteer={onSteer} onEdit={onEdit} onDismiss={onDismiss} />
      ) : (
        <GitTray live={live} worker={worker} wtStatus={wtStatus} />
      )}
    </div>
  );
}
