import { useUi } from "../../state/ui.jsx";

// Web-only collapsed-sidebar control at the header's left edge. Reads the
// tri-state sidebar mode: collapsed → hamburger (with a breathing accent dot on
// new output); hovering → the panel icon + the floating sidebar card. Click
// expands the sidebar for good; hover opens the transient flyout (240ms leave
// delay lives in the store). Hidden in native, where NativeToggleZone fills in.
function HamburgerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="3" y1="4" x2="11" y2="4" />
      <line x1="3" y1="8" x2="13" y2="8" />
      <line x1="3" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function PanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

export function SideHandle({ popup, hasAttention }) {
  const ui = useUi();
  if (!ui.sideCollapsed) return null;
  const hovering = ui.sidebarMode === "collapsed-hover";

  return (
    <div
      className="side-handle-zone"
      onMouseEnter={ui.hoverSidebarIn}
      onMouseLeave={ui.hoverSidebarOut}
    >
      <button
        className={"side-handle" + (hovering ? " on" : "")}
        onClick={ui.expandSidebar}
        title="Show sidebar"
      >
        {hovering ? <PanelIcon /> : <HamburgerIcon />}
        {!hovering && hasAttention && <span className="sb-new-dot" aria-label="new output" />}
      </button>

      {hovering && popup}
    </div>
  );
}
