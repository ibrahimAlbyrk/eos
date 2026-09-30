import { useUi } from "../state/ui.jsx";
import { useKeybinding } from "../keymap/useKeymap.js";
import { combo } from "../keymap/index.js";

// Cmd+B → collapse / expand the sidebar. The toggle buttons (NativeToggleZone,
// SideHandle, the sidebar's own collapse button) stay the entry point.
export function useSidebarToggleHotkey() {
  const { sideCollapsed, expandSidebar, collapseSidebar } = useUi();
  useKeybinding({
    match: combo("mod+b"),
    run: (ctx, e) => {
      e.preventDefault();
      if (sideCollapsed) expandSidebar();
      else collapseSidebar();
    },
  }, [sideCollapsed, expandSidebar, collapseSidebar]);
}
