import { useEffect, useState } from "react";

// The page is a native view composited ABOVE all DOM, so any DOM layer drawn over
// the browser body (image lightbox, modal, menu, another pane's fullscreen panel)
// would end up hidden under the page. Hit-test a grid over the body: if the
// topmost DOM element at any point is not the body itself, something covers it.
const STEP = 48;
// Keeps the edge strips (the side panel's resize handle) out of the test.
const INSET = 12;

export function isOccluded(el) {
  const r = el.getBoundingClientRect();
  const w = r.width - INSET * 2;
  const h = r.height - INSET * 2;
  if (w <= 0 || h <= 0) return false;
  const cols = Math.max(2, Math.ceil(w / STEP) + 1);
  const rows = Math.max(2, Math.ceil(h / STEP) + 1);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const top = document.elementFromPoint(r.left + INSET + (w * i) / (cols - 1), r.top + INSET + (h * j) / (rows - 1));
      if (top && !el.contains(top)) return true;
    }
  }
  return false;
}

// One check hit-tests ~180 points, a millisecond or more over a long transcript,
// and while a reply streams the body mutates on nearly every frame. So a change
// after a quiet spell is checked on the next frame, and later ones at most once
// per MIN_GAP_MS (a trailing check, so the last change is never missed).
const MIN_GAP_MS = 120;

// Re-checks after any DOM change or window resize.
export function useOcclusion(ref, enabled) {
  const [occluded, setOccluded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) { setOccluded(false); return; }
    let raf = 0;
    let timer = 0;
    let last = -Infinity;
    const check = () => { raf = 0; last = performance.now(); setOccluded(isOccluded(el)); };
    const schedule = () => {
      if (raf || timer) return;
      const wait = last + MIN_GAP_MS - performance.now();
      if (wait <= 0) raf = requestAnimationFrame(check);
      else timer = setTimeout(() => { timer = 0; raf = requestAnimationFrame(check); }, wait);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      window.removeEventListener("resize", schedule);
    };
  }, [ref, enabled]);
  return occluded;
}
