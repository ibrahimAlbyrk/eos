import { useEffect } from "react";

// Mirrors the cursor's position over an element into a px custom property on
// it (rAF-throttled, no re-render). The liquid-glass pointer light reads it:
// --mx along the composer card, --sy down the sidebar.
export function usePointerVar(ref, prop, axis) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    let raf = 0;
    let v = 0;
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      v = axis === "x" ? e.clientX - r.left : e.clientY - r.top;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; el.style.setProperty(prop, `${v}px`); });
    };
    el.addEventListener("pointermove", onMove);
    return () => { el.removeEventListener("pointermove", onMove); cancelAnimationFrame(raf); };
  }, [ref, prop, axis]);
}
