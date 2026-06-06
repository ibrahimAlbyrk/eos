import { useUi } from "../../state/ui.jsx";
import { NativeToggleZone } from "./NativeToggleZone.jsx";
import { SideHandle } from "./SideHandle.jsx";
import { SidebarPopup } from "./SidebarPopup.jsx";

// Shared workspace skeleton: the 3-column grid (sidebar | center | right panel)
// and the native chrome. A view fills the slots; it must not reproduce the grid
// itself. The shared <TabBar/> is placed by each view at the top of its first
// sidebar card, so that card stays anchored to the top of the panel.
//
//   sidebar       — (variant: "full" | "popup") => sidebar content. "full" renders
//                   the panel's cards; "popup" renders the same content inside the
//                   collapsed-hover popup, so both stay in sync by construction.
//   main          — center column (header / body / composer)
//   rightPanel    — explicit grid-column:3 panels (pinned, may render null)
//   gridClass     — view-derived classes that drive grid-template (e.g. file-open)
//   children      — floating overlays (absolute/fixed; out of grid flow)
export function AppLayout({ sidebar, main, rightPanel, gridClass, children }) {
  const ui = useUi();
  const cls = ["app", gridClass, ui.sideCollapsed ? "side-collapsed" : ""]
    .filter(Boolean)
    .join(" ");

  const popup = <SidebarPopup>{sidebar("popup")}</SidebarPopup>;

  return (
    <>
      <NativeToggleZone popup={popup} />
      <div className={cls}>
        <aside className="side">
          {sidebar("full")}
        </aside>

        <section className="center">{main}</section>

        {rightPanel}
        <SideHandle popup={popup} />
        {children}
      </div>
    </>
  );
}
