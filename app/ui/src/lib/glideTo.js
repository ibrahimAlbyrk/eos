// glideToBlock — scroll `wrap` until `el` sits `offset` px below its top edge.
// The target is re-read every frame instead of a one-shot scrollTo: blocks
// passed on the way (content-visibility) swap estimated heights for real ones,
// which would strand a fixed target short of the message. Any user scroll
// input cancels. Returns a cancel function.

import { followStep } from "./scrollStick.js";

const TAU_MS = 90;
const MAX_MS = 1500;
// A longer trip skips ahead and only glides the last stretch.
const MAX_TRAVEL_VIEWPORTS = 2.5;
const CANCEL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

export function glideToBlock(wrap, el, offset) {
  const t0 = performance.now();
  let last = t0;
  let first = true;
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    for (const ev of CANCEL_EVENTS) wrap.removeEventListener(ev, stop);
  };
  const step = (ts) => {
    const max = wrap.scrollHeight - wrap.clientHeight;
    const want = wrap.scrollTop + el.getBoundingClientRect().top - wrap.getBoundingClientRect().top - offset;
    const target = Math.max(0, Math.min(max, want));
    let cur = wrap.scrollTop;
    const span = wrap.clientHeight * MAX_TRAVEL_VIEWPORTS;
    if (first && Math.abs(target - cur) > span) cur = target - Math.sign(target - cur) * span;
    first = false;
    const next = followStep(cur, target, Math.min(64, Math.max(1, ts - last)), { tau: TAU_MS });
    last = ts;
    wrap.scrollTop = next;
    if (next === target || ts - t0 > MAX_MS) return stop();
    raf = requestAnimationFrame(step);
  };
  for (const ev of CANCEL_EVENTS) wrap.addEventListener(ev, stop, { passive: true });
  raf = requestAnimationFrame(step);
  return stop;
}
