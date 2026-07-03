import { useSyncExternalStore } from "react";
import { subscribe, getPtyPanel, togglePanel } from "../../../state/ptyPanelStore.js";

// Top-right toolbar toggle for the embedded terminal panel. Mirrors the
// FollowButton idiom (pane-split-btn + is-active state, 14x14 inline SVG).
export function TerminalToggleButton() {
  const { panelOpen } = useSyncExternalStore(subscribe, getPtyPanel);

  return (
    <button
      className={"pane-split-btn" + (panelOpen ? " is-active" : "")}
      onClick={togglePanel}
      title={panelOpen ? "Hide terminal" : "Show terminal"}
      aria-label="Toggle terminal panel"
      aria-pressed={panelOpen}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
        <path d="M4 6l2.5 2L4 10" />
        <line x1="8" y1="10.5" x2="11" y2="10.5" />
      </svg>
    </button>
  );
}
