import { useEffect, useRef, useState } from "react";

const HOVER_OPEN_MS = 350;
const HOVER_CLOSE_MS = 150;

// Open/close timers for a hover card that must survive the pointer crossing the
// gap between its anchor and the card itself. `payload` travels with the anchor
// for a card that serves many anchors (which one is it showing).
export function useHoverCard({ openMs = HOVER_OPEN_MS } = {}) {
  const [open, setOpen] = useState(null);
  const timer = useRef(null);
  const clear = () => clearTimeout(timer.current);
  useEffect(() => clear, []);
  return {
    anchor: open?.anchor ?? null,
    payload: open?.payload ?? null,
    enterAnchor: (el, payload) => {
      clear();
      timer.current = setTimeout(() => setOpen({ anchor: el.getBoundingClientRect(), payload }), openMs);
    },
    enterCard: clear,
    leave: () => { clear(); timer.current = setTimeout(() => setOpen(null), HOVER_CLOSE_MS); },
    close: () => { clear(); setOpen(null); },
  };
}
