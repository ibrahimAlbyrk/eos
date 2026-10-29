// useTweenedNumber — follows `value`, gliding from the number on screen to a
// new one (ease-out over `ms`) instead of jumping. The first value shows as is;
// a change mid-glide carries on from where it is.

import { useEffect, useRef, useState } from "react";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function useTweenedNumber(value, ms = 700) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (from === value || reducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    let raf = requestAnimationFrame(function step(ts) {
      const k = Math.min(1, Math.max(0, (ts - t0) / ms));
      shownRef.current = from + (value - from) * (1 - (1 - k) ** 3);
      setShown(shownRef.current);
      if (k < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}
