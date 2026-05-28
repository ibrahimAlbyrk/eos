import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";

// Native macOS chrome: a fixed sidebar toggle near the traffic lights. When the
// sidebar is collapsed, hovering reveals a popup whose content is view-specific
// (passed in via `popup`).
export function NativeToggleZone({ popup }) {
  const ui = useUi();
  const [hover, setHover] = useState(false);
  const leaveTimer = useRef(null);
  const insideRef = useRef(false);
  const popRef = useRef(ui.openPopover);
  popRef.current = ui.openPopover;

  const onEnter = useCallback(() => {
    insideRef.current = true;
    clearTimeout(leaveTimer.current);
    if (ui.sideCollapsed) setHover(true);
  }, [ui.sideCollapsed]);

  const onLeave = useCallback(() => {
    insideRef.current = false;
    leaveTimer.current = setTimeout(() => {
      if (!popRef.current) setHover(false);
    }, 200);
  }, []);

  useEffect(() => {
    if (!ui.openPopover && hover && !insideRef.current) {
      leaveTimer.current = setTimeout(() => setHover(false), 300);
    }
  }, [ui.openPopover, hover]);

  return (
    <div className="native-toggle-zone" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button
        className="native-toggle sb-iconbtn"
        onClick={() => { ui.setSideCollapsed(!ui.sideCollapsed); setHover(false); }}
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
      {hover && ui.sideCollapsed && popup}
    </div>
  );
}
