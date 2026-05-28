import { useUi } from "../../state/ui.jsx";
import { NativeToggleZone } from "./NativeToggleZone.jsx";

// Shared workspace skeleton: the 3-column grid (sidebar | center | right panel)
// and the native chrome. A view fills the slots; it must not reproduce the grid
// itself. The shared <TabBar/> is placed by each view at the top of its first
// sidebar card, so that card stays anchored to the top of the panel.
//
//   sidebar       — the collapsing sidebar's cards (first card hosts the TabBar)
//   main          — center column (header / body / composer)
//   rightPanel    — explicit grid-column:3 panels (pinned, may render null)
//   gridClass     — view-derived classes that drive grid-template (e.g. file-open)
//   collapsedPopup — hover popup shown by the native toggle when collapsed
//   children      — floating overlays (absolute/fixed; out of grid flow)
export function AppLayout({ sidebar, main, rightPanel, gridClass, collapsedPopup, children }) {
  const ui = useUi();
  const cls = ["app", gridClass, ui.sideCollapsed ? "side-collapsed" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <NativeToggleZone popup={collapsedPopup} />
      <div className={cls}>
        <aside className="side">
          {sidebar}
        </aside>

        <section className="center">{main}</section>

        {rightPanel}
        {children}
      </div>
    </>
  );
}
