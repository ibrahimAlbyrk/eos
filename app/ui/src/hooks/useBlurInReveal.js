import { useLayoutEffect, useRef } from "react";
import { applyBlurIn, clearBlurIn } from "../lib/blurInReveal.js";

// Reveals freshly arrived message text word-by-word. revealedRef tracks how
// many words are already on screen so a block that grows across polls only
// animates its appended tail. Layout effect: words must be wrapped before
// paint or the text flashes sharp for one frame.
export function useBlurInReveal(ref, html, enabled) {
  const revealedRef = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const { total, settleMs } = applyBlurIn(el, revealedRef.current);
    revealedRef.current = total;
    if (!settleMs) return;
    const t = setTimeout(() => clearBlurIn(el), settleMs + 100);
    return () => clearTimeout(t);
  }, [html, enabled]);
}
