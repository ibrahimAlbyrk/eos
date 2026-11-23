// The Home ↔ field transition (08 §4.6, Transition.dc.html): its phases,
// its timings and the checks that keep the flying input smooth. Every timing
// is the design's own, scaled by the CSS `--k` (1; 0 with reduced motion,
// where Home and the field only cross-fade in 120 ms).

export const PHASES = ["home", "entering", "field", "leaving"];

// home → entering → field → leaving → home; entering and leaving turn round
// at once, from wherever they are.
export function nextPhase(phase, event) {
  if (event === "open") return phase === "home" || phase === "leaving" ? "entering" : phase;
  if (event === "leave") return phase === "entering" || phase === "field" ? "leaving" : phase;
  if (event === "ended") return phase === "entering" ? "field" : phase === "leaving" ? "home" : phase;
  return phase;
}

// The last disc ends its spring at 900 + 780 ms; the input lands at
// 60 + 920 ms. Leaving uses the base timings: Home's lower sections are back
// at 440 + 420 ms, the rings at 120 + 760 ms.
export const ENTER_MS = 1680;
export const LEAVE_MS = 880;
export const REDUCED_MS = 120;

export function phaseMs(phase, reduced) {
  if (reduced) return REDUCED_MS;
  return phase === "entering" ? ENTER_MS : phase === "leaving" ? LEAVE_MS : 0;
}

export function reducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const DISC_FIRST_MS = 560;
const DISC_SPREAD_MS = 340;
const DISC_LAST_MS = 900;
const MANY_DISCS = 12;
const RING_START_MS = [560, 700, 840];
const PER_DISC_MS = 15;

// When a disc starts to appear: spread over 340 ms after 560 ms, capped at
// 900; with more than twelve, ring by ring with 15 ms between discs.
// `discs` are in the order they are drawn, each with its `ring`.
export function discDelays(discs) {
  const n = discs.length;
  if (n > MANY_DISCS) {
    const seen = { 1: 0, 2: 0, 3: 0 };
    return discs.map((d) => RING_START_MS[d.ring - 1] + PER_DISC_MS * seen[d.ring]++);
  }
  return discs.map((_, i) => Math.min(DISC_LAST_MS, DISC_FIRST_MS + (n > 1 ? (i * DISC_SPREAD_MS) / (n - 1) : 0)));
}

// Horizon dots leave between 220 and 420 ms, the newest first.
export const dotDelay = (i, n) => 220 + (n > 1 ? Math.round((200 * (n - 1 - i)) / (n - 1)) : 0);

const TRAPS = ["transform", "filter", "mask", "clipPath", "backdropFilter", "willChange", "contain", "opacity"];

// The first ancestor that would hold the fixed input in place of the window
// (a transform, filter, mask, clip, backdrop filter, paint containment or
// opacity below 1 makes it the containing block or a backdrop root), or null.
export function flightTrap(el) {
  for (let node = el?.parentElement; node && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    for (const prop of TRAPS) {
      const v = style[prop];
      if (prop === "opacity" ? Number(v) < 1 : prop === "contain" ? /paint|strict|content/.test(v) : prop === "willChange" ? /transform|filter|opacity/.test(v) : v && v !== "none") {
        return { node, prop };
      }
    }
  }
  return null;
}
