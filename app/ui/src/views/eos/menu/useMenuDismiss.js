import { useEffect, useRef } from "react";

// Listens on `doc` until the returned function is called: a press outside
// `wrapper()` (which holds the trigger too, so the trigger still toggles) or
// Escape anywhere calls `close`.
export function watchDismiss(doc, wrapper, close) {
  const onDown = (e) => { if (!wrapper()?.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  doc.addEventListener("mousedown", onDown);
  doc.addEventListener("keydown", onKey);
  return () => {
    doc.removeEventListener("mousedown", onDown);
    doc.removeEventListener("keydown", onKey);
  };
}

// While a menu is open, a press outside it or Escape closes it. Returns the
// ref for the menu's wrapper.
export function useMenuDismiss(open, close) {
  const ref = useRef(null);
  useEffect(() => (open ? watchDismiss(document, () => ref.current, close) : undefined), [open, close]);
  return ref;
}
