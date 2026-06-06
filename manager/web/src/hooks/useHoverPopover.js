import { useCallback, useEffect, useRef, useState } from "react";

// Switching tabs from inside the popup remounts the whole layout (each view
// renders its own AppLayout), which would reset hover state and close the
// popup mid-click. Remember it at module scope so the fresh instance restores
// the open popup — same trick as TabBar's prevIndex.
let lastOpen = false;

// Hover-intent for the collapsed-sidebar popup: a short leave delay lets the
// pointer cross the gap to the popup, and the popup stays open while a
// popover (e.g. context menu) spawned from inside it is open.
export function useHoverPopover({ openPopover, enabled = true }) {
  const [open, setOpenState] = useState(lastOpen);
  const leaveTimer = useRef(null);
  const insideRef = useRef(lastOpen);
  const popRef = useRef(openPopover);
  popRef.current = openPopover;

  const setOpen = useCallback((v) => {
    lastOpen = v;
    setOpenState(v);
  }, []);

  const onMouseEnter = useCallback(() => {
    insideRef.current = true;
    clearTimeout(leaveTimer.current);
    if (enabled) setOpen(true);
  }, [enabled, setOpen]);

  const onMouseLeave = useCallback(() => {
    insideRef.current = false;
    leaveTimer.current = setTimeout(() => {
      if (!popRef.current) setOpen(false);
    }, 200);
  }, [setOpen]);

  useEffect(() => {
    if (!openPopover && open && !insideRef.current) {
      leaveTimer.current = setTimeout(() => setOpen(false), 300);
    }
  }, [openPopover, open, setOpen]);

  const close = useCallback(() => {
    clearTimeout(leaveTimer.current);
    setOpen(false);
  }, [setOpen]);

  return { open, close, onMouseEnter, onMouseLeave };
}
