import { useEffect, useLayoutEffect, useRef } from "react";
import { useField } from "./fieldStore.js";
import { flightTrap } from "./transition.js";

// A layout effect in the window; on the server (tests) a plain one, which
// never runs there.
export const useWindowLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const FIELD_WIDTH = 580;
const FIELD_GUTTER = 48;
// The input's top in the field, from the window's centre: the caption sits
// above it (placeDiscs keeps that zone clear).
const FIELD_TOP = -49;

const ENTER = "calc(var(--k) * 920ms) var(--ease) calc(var(--k) * 60ms)";
const LEAVE = "calc(var(--k) * 640ms) var(--ease)";
const FLIGHT_PROPS = ["position", "zIndex", "left", "top", "margin", "width", "transform", "transition"];

export function fieldRect(W = window.innerWidth, H = window.innerHeight) {
  const width = Math.min(FIELD_WIDTH, W - FIELD_GUTTER);
  return { left: (W - width) / 2, top: H / 2 + FIELD_TOP, width };
}

// Moves the fixed input from where it is now (`current`) to `to`, anchored
// at `base`: only its transform and its width move (FLIP).
function fly(block, { base, current, to, timing }) {
  const s = block.style;
  s.transition = "none";
  s.position = "fixed";
  s.zIndex = "41";
  s.margin = "0";
  s.left = `${base.left}px`;
  s.top = `${base.top}px`;
  s.width = `${current.width}px`;
  s.transform = `translate(${current.left - base.left}px, ${current.top - base.top}px)`;
  void block.offsetWidth;
  s.transition = `transform ${timing}, width ${timing}`;
  s.transform = `translate(${to.left - base.left}px, ${to.top - base.top}px)`;
  s.width = `${to.width}px`;
}

function land(block) {
  for (const prop of FLIGHT_PROPS) block.style[prop] = "";
}

let checked = false;

// The Home input's flight between its place on Home and the field's centre
// (08 §4.6). It stays the same node, so focus and text survive. On entry its
// place keeps its height and it turns fixed where it was, then moves; in the
// field the stylesheet holds it; on leaving it flies back to its place, which
// is measured again (the window may have changed), then returns to the flow.
export function useInputFlight(blockRef, placeRef) {
  const { phase } = useField();
  const was = useRef(phase);
  useWindowLayoutEffect(() => {
    const block = blockRef.current;
    const place = placeRef.current;
    const from = was.current;
    was.current = phase;
    if (!block || !place || from === phase) return;
    if (import.meta.env?.DEV && !checked) {
      checked = true;
      const trap = flightTrap(block);
      if (trap) console.warn(`The Home input cannot fly: an ancestor sets ${trap.prop}.`, trap.node);
    }
    const current = block.getBoundingClientRect();
    if (phase === "entering") {
      if (from === "home") place.style.height = `${current.height}px`;
      fly(block, { base: place.getBoundingClientRect(), current, to: fieldRect(), timing: ENTER });
    } else if (phase === "leaving") {
      const base = place.getBoundingClientRect();
      fly(block, { base, current, to: base, timing: LEAVE });
    } else {
      land(block);
      if (phase === "home") place.style.height = "";
    }
  }, [phase, blockRef, placeRef]);
}
