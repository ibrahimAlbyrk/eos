// Left spacer that clears the native window chrome (macOS traffic lights +
// sidebar-expand toggle) for a docked panel's HEADER when that panel is
// fullscreen at the window top-left with the sidebar collapsed. Sized entirely
// by CSS (.dock-chrome-inset, gated on .app.side-collapsed .pane-panel-slot
// .is-fullscreen); hidden in every other state. Mirrors PaneHeader's
// .pane-head-inset, shared by every dock panel header that can go fullscreen
// (terminal tab bar, git diff header) so the clearance lives in ONE place.
export function DockChromeInset() {
  return <span className="dock-chrome-inset" aria-hidden="true" />;
}
