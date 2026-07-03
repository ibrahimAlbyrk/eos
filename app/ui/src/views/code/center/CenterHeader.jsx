import { useUi } from "../../../state/ui.jsx";
import { PanePresets } from "./PanePresets.jsx";
import { FollowButton } from "./FollowButton.jsx";

// Slim window-chrome strip above the pane grid: the sidebar-reopen toggle plus
// the global layout controls (follow + saved presets). The breadcrumb, rename,
// agent menu, terminal, and split all moved INTO each pane's own PaneHeader.
export function CenterHeader() {
  const ui = useUi();

  return (
    <div className="head">
      <button className="head-toggle sb-iconbtn" onClick={() => ui.setSideCollapsed(false)} title="Show sidebar">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <line x1="6" y1="3" x2="6" y2="13" />
        </svg>
      </button>
      <div className="right">
        <FollowButton />
        <PanePresets />
      </div>
    </div>
  );
}
