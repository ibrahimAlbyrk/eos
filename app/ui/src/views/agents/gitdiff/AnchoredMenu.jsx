import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// A glass dropdown under an anchor, portal'd to <body> (the panel sits in a
// paint-contained pane that would clip it). Closes on an outside pointerdown or
// Escape; `keepOpenOn` lets a dialog the menu opened count as inside.
export function AnchoredMenu({ anchorRef, onClose, align = "left", width, className = "", keepOpenOn, children }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (!r) return;
    const w = width ?? ref.current?.offsetWidth ?? 260;
    const left = align === "right" ? r.right - w : r.left;
    setPos({ top: Math.round(r.bottom + 6), left: Math.round(Math.max(8, Math.min(left, window.innerWidth - w - 8))) });
  }, [anchorRef, align, width]);

  useEffect(() => {
    const down = (e) => {
      if (ref.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      if (keepOpenOn && e.target.closest?.(keepOpenOn)) return;
      onClose();
    };
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", down); window.removeEventListener("keydown", key, true); };
  }, [anchorRef, onClose, keepOpenOn]);

  return createPortal(
    <div
      ref={ref}
      className={"cx-menu glass-pop " + className}
      role="menu"
      style={{ ...(pos ?? { top: -9999, left: -9999 }), ...(width ? { width } : {}) }}
    >
      {children}
    </div>,
    document.body,
  );
}
