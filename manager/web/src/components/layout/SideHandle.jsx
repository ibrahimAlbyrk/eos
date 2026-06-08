import { useUi } from "../../state/ui.jsx";
import { useHoverPopover } from "../../hooks/useHoverPopover.js";

// Web-only expand handle shown when the sidebar is collapsed; hovering
// reveals the view's sidebar popup. Hidden in native mode, where
// NativeToggleZone fills the role.
export function SideHandle({ popup, hasAttention }) {
  const ui = useUi();
  const { open, onMouseEnter, onMouseLeave } = useHoverPopover({ openPopover: ui.openPopover });

  if (!ui.sideCollapsed) return null;

  return (
    <div
      className="side-handle-zone"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <button
        className={`side-handle${hasAttention ? " attention-blink" : ""}`}
        onClick={() => ui.setSideCollapsed(false)}
        title="Show sidebar"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <line x1="6" y1="3" x2="6" y2="13" />
        </svg>
      </button>

      {open && popup}
    </div>
  );
}
