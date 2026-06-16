import { useUi } from "../../state/ui.jsx";

// Shared workspace skeleton: the 3-column grid (sidebar | center | right panel).
// A view fills the slots; it must not reproduce the grid itself. The shared
// <TabBar/> is placed by each view at the top of its first sidebar card, so that
// card stays anchored to the top of the panel. The collapsed-rail chrome and
// hover flyout are rendered once by the Shell (App.jsx), not here, so they
// survive view switches.
//
//   sidebar       — (variant: "full" | "popup") => sidebar content. "full" renders
//                   the panel's cards here; the Shell renders "popup" into the
//                   collapsed-hover flyout, so both stay in sync by construction.
//   main          — center column (header / body / composer)
//   rightPanel    — explicit grid-column:3 panels (pinned, may render null)
//   gridClass     — view-derived classes that drive grid-template (e.g. file-open)
//   children      — floating overlays (absolute/fixed; out of grid flow)
export function AppLayout({ sidebar, main, rightPanel, gridClass, children }) {
  const ui = useUi();
  const cls = ["app", gridClass, ui.sideCollapsed ? "side-collapsed" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      <aside className="side">
        {sidebar("full")}
      </aside>

      <section className="center">{main}</section>

      {rightPanel}
      {children}
    </div>
  );
}
