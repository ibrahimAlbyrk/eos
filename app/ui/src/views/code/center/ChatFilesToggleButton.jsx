import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { subscribe, getSnapshot, attach } from "../../../state/chatAttachmentsStore.js";

// Top-right toolbar toggle for the "Files in Chat" docked panel (FilesToggle
// idiom). Scoped to the pane's agent — the panel lists every attachment sent to
// THAT worker. The button only appears once the agent has at least one
// attachment; a count badge on the icon tracks the total live.
export function ChatFilesToggleButton({ worker }) {
  const ui = useUi();
  const open = ui.isPanelOpen("chatfiles");
  const workerId = worker?.id ?? null;

  // Attach the store here too (ref-counted, shared with the panel) so the count
  // stays live whether or not the panel is open. The read doubles as the server
  // snapshot — PaneHeader is server-rendered in tests, where the third arg is
  // required.
  const readSnap = useCallback(() => getSnapshot(workerId), [workerId]);
  const snap = useSyncExternalStore(
    useCallback((cb) => (workerId ? subscribe(workerId, cb) : () => {}), [workerId]),
    readSnap,
    readSnap,
  );
  useEffect(() => {
    if (!workerId) return;
    return attach(workerId);
  }, [workerId]);

  const count = snap.attachments.length;

  const onClick = () => {
    if (open) { ui.closeChatFilesViewer(); return; }
    ui.openChatFilesViewer(workerId);
  };

  // No attachments yet → the button stays hidden entirely.
  if (!count) return null;

  return (
    <button
      className={"pane-split-btn chatfiles-toggle" + (open ? " is-active" : "")}
      onClick={onClick}
      title={open ? "Hide files in chat" : "Show files in chat"}
      aria-label={`Toggle files in chat panel (${count})`}
      aria-pressed={open}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13.5 7.5 8.2 12.8a3 3 0 0 1-4.24-4.24l5.3-5.3a2 2 0 0 1 2.83 2.82l-5.3 5.3a1 1 0 0 1-1.42-1.41l4.9-4.9" />
      </svg>
      <span className="chatfiles-badge" aria-hidden="true">{count}</span>
    </button>
  );
}
