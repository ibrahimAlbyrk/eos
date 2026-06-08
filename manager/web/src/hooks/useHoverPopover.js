import { useCallback, useEffect, useRef, useState } from "react";

// Hover-intent for the collapsed-sidebar popup: a short leave delay lets the
// pointer cross the gap to the popup, and the popup stays open while a
// popover (e.g. context menu) spawned from inside it is open. The hook is
// mounted once by the Shell, so its open state survives view switches.
export function useHoverPopover({ openPopover, enabled = true }) {
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef(null);
  const insideRef = useRef(false);
  const popRef = useRef(openPopover);
  popRef.current = openPopover;

  const onMouseEnter = useCallback(() => {
    insideRef.current = true;
    clearTimeout(leaveTimer.current);
    if (enabled) setOpen(true);
  }, [enabled]);

  const onMouseLeave = useCallback(() => {
    insideRef.current = false;
    leaveTimer.current = setTimeout(() => {
      if (!popRef.current) setOpen(false);
    }, 200);
  }, []);

  useEffect(() => {
    if (!openPopover && open && !insideRef.current) {
      leaveTimer.current = setTimeout(() => setOpen(false), 300);
    }
  }, [openPopover, open]);

  const close = useCallback(() => {
    clearTimeout(leaveTimer.current);
    setOpen(false);
  }, []);

  return { open, close, onMouseEnter, onMouseLeave };
}
