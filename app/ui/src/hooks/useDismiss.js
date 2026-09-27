import { useEffect } from "react";

// Close a popover on Escape or on a mousedown outside its wrapper — the
// popover's parent element, which also holds the trigger, so clicking the
// trigger toggles instead of closing and reopening.
export function useDismiss(ref, onClose) {
  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.parentElement?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [ref, onClose]);
}
