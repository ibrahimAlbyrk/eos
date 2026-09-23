import { useUi } from "../../state/ui.jsx";

// Native macOS chrome: a fixed sidebar toggle near the traffic lights (the
// sidebar's own .side-top strip is hidden in native, where the OS draws the
// window controls). Expanded → panel icon collapses; collapsed → hamburger (with
// a breathing accent dot on new output) that expands on click and reveals the
// floating sidebar card on hover. Search moved to the Eos ▾ row.
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

export function NativeToggleZone({ popup, hasAttention }) {
  const ui = useUi();
  const collapsed = ui.sideCollapsed;
  const hovering = ui.sidebarMode === "collapsed-hover";
  const showDot = hasAttention && collapsed && !hovering;

  return (
    <div
      className="native-toggle-zone"
      onMouseEnter={collapsed ? ui.hoverSidebarIn : undefined}
      onMouseLeave={collapsed ? ui.hoverSidebarOut : undefined}
    >
      <button
        className={"native-toggle sb-iconbtn" + (hovering ? " on" : "")}
        onClick={() => (collapsed ? ui.expandSidebar() : ui.collapseSidebar())}
        title={collapsed ? "Show sidebar" : "Hide sidebar"}
      >
        {collapsed && !hovering ? <HamburgerIcon /> : <PanelIcon />}
        {showDot && <span className="sb-new-dot" aria-label="new output" />}
      </button>
      {hovering && popup}
    </div>
  );
}
