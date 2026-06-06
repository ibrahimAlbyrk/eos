import { useUi } from "../../state/ui.jsx";
import { useHoverPopover } from "../../hooks/useHoverPopover.js";

// Native macOS chrome: a fixed sidebar toggle near the traffic lights. When the
// sidebar is collapsed, hovering reveals a popup whose content is view-specific
// (passed in via `popup`).
export function NativeToggleZone({ popup }) {
  const ui = useUi();
  const { open, close, onMouseEnter, onMouseLeave } = useHoverPopover({
    openPopover: ui.openPopover,
    enabled: ui.sideCollapsed,
  });

  return (
    <div className="native-toggle-zone" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <button
        className="native-toggle sb-iconbtn"
        onClick={() => { ui.setSideCollapsed(!ui.sideCollapsed); close(); }}
        title={ui.sideCollapsed ? "Show sidebar" : "Hide sidebar"}
      >
        {ui.sideCollapsed ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="3" y1="4" x2="11" y2="4" />
            <line x1="3" y1="8" x2="13" y2="8" />
            <line x1="3" y1="12" x2="9" y2="12" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <line x1="6" y1="3" x2="6" y2="13" />
          </svg>
        )}
      </button>
      {!ui.sideCollapsed && (
        <button
          className="native-toggle sb-iconbtn"
          onClick={() => { ui.openSearch(); close(); }}
          title="Search (⌘K)"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="5" />
            <path d="m13 13-2.5-2.5" />
          </svg>
        </button>
      )}
      {open && ui.sideCollapsed && popup}
    </div>
  );
}
