import { useUi } from "../../../state/ui.jsx";

// Top-right toolbar toggle for the docked browser panel (same panel stack as
// the terminal/file viewers). Hiding the panel drops the frame stream; the tab
// itself lives in the daemon and reattaches on reopen.
export function BrowserToggleButton() {
  const ui = useUi();
  const open = ui.isPanelOpen("browser");

  return (
    <button
      className={"pane-split-btn" + (open ? " is-active" : "")}
      onClick={() => (open ? ui.closeBrowserViewer() : ui.openBrowserViewer())}
      title={open ? "Hide browser" : "Show browser"}
      aria-label="Toggle browser panel"
      aria-pressed={open}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="6.5" />
        <ellipse cx="8" cy="8" rx="3" ry="6.5" />
        <line x1="1.5" y1="8" x2="14.5" y2="8" />
      </svg>
    </button>
  );
}
