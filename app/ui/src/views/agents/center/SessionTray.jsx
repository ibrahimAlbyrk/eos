import { QueueTray } from "./QueueTray.jsx";

// The tray slot behind the composer card once a session exists: queued
// messages while there are any. Git actions live in the composer's git menu.
export function SessionTray({ queued, onSteer, onEdit, onDismiss }) {
  if (queued.length === 0) return null;
  return (
    <div className="session-tray">
      <QueueTray items={queued} onSteer={onSteer} onEdit={onEdit} onDismiss={onDismiss} />
    </div>
  );
}
