import { useUi } from "../../../state/ui.jsx";
import { killAllSessions } from "../../../state/ptyPanelStore.js";

// Top-right toolbar toggle for the embedded terminal panel. Opens/closes the
// "terminal" docked panel on the focused pane (same panel stack as the file/
// diff viewers). Uses the shared pane-split-btn + is-active button idiom.
export function TerminalToggleButton() {
  const ui = useUi();
  const open = ui.isPanelOpen("terminal");

  return (
    <button
      className={"pane-split-btn" + (open ? " is-active" : "")}
      onClick={() => (open ? (killAllSessions(), ui.closeTerminalViewer()) : ui.openTerminalViewer())}
      title={open ? "Hide terminal" : "Show terminal"}
      aria-label="Toggle terminal panel"
      aria-pressed={open}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M4 6l2.5 2L4 10" />
        <line x1="8" y1="10.5" x2="11" y2="10.5" />
      </svg>
    </button>
  );
}
