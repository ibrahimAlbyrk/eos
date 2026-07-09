// PanelFrame — the positioned chrome for one docked panel: an absolute %-rect slot
// the tiling engine (lib/panelTiling) sizes, keyed by type upstream for keep-alive.
// The viewer inside renders its island surface + header via the shared PanelShell.
// Extracted so the dock's per-panel positioning is one component and adding a
// panel type never touches it (open/closed).
const pctStyle = (r) => ({ left: `${r.left}%`, top: `${r.top}%`, width: `${r.width}%`, height: `${r.height}%` });

export function PanelFrame({ rect, children }) {
  return (
    <div className="panel-tile-slot" style={pctStyle(rect)}>
      {children}
    </div>
  );
}
