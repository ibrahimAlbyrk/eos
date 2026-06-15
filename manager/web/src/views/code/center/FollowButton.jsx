import { useUi } from "../../../state/ui.jsx";

// "Follow" toggle — sits beside the split controls in the header. A sticky mode:
// while ON the split auto-tracks the selected orchestrator (orchestrator left,
// its children tiled right) as children spawn / go idle / are killed. When the
// selection isn't an orchestrator it stays ON but dormant (shows that agent
// alone) and re-opens the fanout the moment you pick an orchestrator again. Only
// this button turns it off; the on-state persists across reloads.
export function FollowButton() {
  const ui = useUi();
  const on = ui.followMode;

  return (
    <button
      className={"pane-split-btn" + (on ? " is-active" : "")}
      onClick={ui.toggleFollow}
      title={on ? "Following orchestrator children — click to stop" : "Follow the orchestrator's children (live split)"}
      aria-label="Follow orchestrator children"
      aria-pressed={on}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}
