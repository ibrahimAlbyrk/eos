// User-authored ultracode animation (from the effort-slider.html mock):
// two-octave value-noise scrolling right-to-left, brightness ramping toward
// the thumb, occasional sparkles, indigo→violet→pink HSL palette. Every
// frame is a pure function of (cell, time).

export const CELL = 4;       // cell pitch — 5 rows fill the 22px bar
export const DOT = 3;        // square size inside cell
export const PAD_Y = 1;      // vertical grid inset
export const FLOW_SPEED = 9; // cells per second, right-to-left

export function hash(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

const smooth = (t) => t * t * (3 - 2 * t);

export function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  const u = smooth(xf);
  const v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Muted gray-violet palette matched to the Claude Code reference bar: low
// saturation throughout, dim slate-purple up to pale lavender, with only a
// gentle hue drift.
export function cellColor(bright, shimmer) {
  const hue = 262 + shimmer * 12 - 6;
  const sat = 12 + bright * 18;
  const lit = 22 + bright * 52;
  return `hsl(${hue.toFixed(1)},${sat.toFixed(1)}%,${lit.toFixed(1)}%)`;
}
