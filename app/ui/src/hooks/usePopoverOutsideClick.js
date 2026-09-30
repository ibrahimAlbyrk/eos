import { useEffect } from "react";

// Outside-click closes any open popover (except the popover itself + trigger).
// Lives in the Shell so it covers every view, not just Agents.
export function usePopoverOutsideClick(ui) {
  useEffect(() => {
    if (!ui.openPopover) return;
    const handler = (e) => {
      const inside = e.target.closest(`[data-popover="${ui.openPopover}"]`)
        || e.target.closest(`[data-popover-trigger="${ui.openPopover}"]`);
      if (!inside) ui.closeAllPops();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ui.openPopover, ui]);
}
