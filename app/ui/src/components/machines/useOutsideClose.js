import { useEffect } from "react";

// Close a portal'd card on Escape or a mousedown outside it. The trigger is
// excluded so clicking it toggles instead of closing and instantly reopening.
export function useOutsideClose(cardRef, triggerRef, onClose) {
  useEffect(() => {
    const onDown = (e) => {
      if (cardRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [cardRef, triggerRef, onClose]);
}
