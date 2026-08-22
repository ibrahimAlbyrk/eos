import { useCallback, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { findLeaf } from "../../../lib/paneLayout.js";
import { sessionRootOf } from "../../../lib/agentIndex.js";
import { subscribe, getSessionState } from "../../../state/browserSessionState.js";

// Top-right toolbar toggle for the docked browser panel (same panel stack as
// the terminal/file viewers). Hiding the panel drops the frame stream; the tabs
// live in the daemon per SESSION and reattach on reopen. A dot marks unseen
// agent browser activity in this pane's session while the panel is closed;
// opening the panel clears it (BrowserPanel's mount zeroes the count). An empty
// pane targets the shared "global" session.
export function BrowserToggleButton() {
  const ui = useUi();
  const open = ui.isPanelOpen("browser");
  const sessionKey = sessionRootOf(findLeaf(ui.tree, ui.paneId)?.agentId);
  const getSnap = useCallback(() => getSessionState(sessionKey), [sessionKey]);
  // getSnap doubles as the server snapshot — PaneHeader tests render this
  // statically (renderToStaticMarkup), which requires the third argument.
  const session = useSyncExternalStore(
    useCallback((cb) => subscribe(sessionKey, cb), [sessionKey]),
    getSnap,
    getSnap,
  );
  const dot = session.unseenCount > 0 && !open;

  return (
    <button
      className={"pane-split-btn browser-toggle" + (open ? " is-active" : "")}
      onClick={() => (open ? ui.closeBrowserViewer() : ui.openBrowserViewer({ sessionKey }))}
      title={open ? "Hide browser" : "Show browser"}
      aria-label="Toggle browser panel"
      aria-pressed={open}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6.5" />
        <ellipse cx="8" cy="8" rx="3" ry="6.5" />
        <line x1="1.5" y1="8" x2="14.5" y2="8" />
      </svg>
      {dot && <span className="browser-toggle__dot" aria-hidden="true" />}
    </button>
  );
}
