import { useUi } from "../../../state/ui.jsx";
import { leafCount, MAX_PANES } from "../../../lib/paneLayout.js";

// "Open empty split" — sits beside PanePresets in the header (the pane-layout
// control cluster). Splits the focused pane into a fresh EMPTY pane (no agent),
// reusing the existing splitWithAgent action with a null agent. The new empty
// pane then surfaces the hover agent picker.
export function SplitEmptyButton() {
  const ui = useUi();
  const canSplit = leafCount(ui.tree) < MAX_PANES;

  const openEmptySplit = () => {
    if (!canSplit) return;
    ui.splitWithAgent(ui.focusedLeafId, "row", "after", null);
  };

  return (
    <button
      className="pane-split-btn"
      onClick={openEmptySplit}
      disabled={!canSplit}
      title="Open empty split"
      aria-label="Open empty split"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <line x1="8" y1="2.5" x2="8" y2="13.5" />
        <path d="M11 6.2v3.6M9.2 8h3.6" />
      </svg>
    </button>
  );
}
