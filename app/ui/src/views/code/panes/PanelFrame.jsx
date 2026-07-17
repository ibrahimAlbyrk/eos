// PanelFrame — the positioned chrome for one docked panel: an absolute %-rect slot
// the tiling engine (lib/panelTiling) sizes, keyed by type upstream for keep-alive.
// The viewer inside renders its island surface + header via the shared PanelShell.
// Extracted so the dock's per-panel positioning is one component and adding a
// panel type never touches it (open/closed).
const pctStyle = (r) => ({ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` });

// `hidden` keeps the tile MOUNTED but out of paint (display:none) so a maximized
// sibling can cover the dock without unmounting the others — the keep-alive /
// no-re-parent invariant (live PTY scrollback) still holds.
export function PanelFrame({ rect, hidden, children }) {
  return (
    <div className={"panel-tile-slot" + (hidden ? " is-hidden" : "")} style={pctStyle(rect)}>
      {children}
    </div>
  );
}
