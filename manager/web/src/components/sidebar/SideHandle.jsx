import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { SidePopup } from "./SidePopup.jsx";

export function SideHandle({ live }) {
  const ui = useUi();
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef(null);
  const insideRef = useRef(false);
  const popoverRef = useRef(ui.openPopover);
  popoverRef.current = ui.openPopover;

  const enter = useCallback(() => {
    insideRef.current = true;
    clearTimeout(leaveTimer.current);
    setHovered(true);
  }, []);

  const leave = useCallback(() => {
    insideRef.current = false;
    leaveTimer.current = setTimeout(() => {
      if (!popoverRef.current) setHovered(false);
    }, 200);
  }, []);

  useEffect(() => {
    if (!ui.openPopover && hovered && !insideRef.current) {
      leaveTimer.current = setTimeout(() => setHovered(false), 300);
    }
  }, [ui.openPopover, hovered]);

  if (!ui.sideCollapsed) return null;

  return (
    <div
      className="side-handle-zone"
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      <button
        className="side-handle"
        onClick={() => ui.setSideCollapsed(false)}
        title="Show sidebar"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <line x1="6" y1="3" x2="6" y2="13" />
        </svg>
      </button>

      {hovered && <SidePopup live={live} />}
    </div>
  );
}
