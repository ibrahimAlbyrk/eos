// Geometry for the effort slider: an ordered scale of N stops on a 0..1 axis.

// Horizontal inset keeping the thumb and end dots inside the track's rounded
// corners; pointer→fraction mapping inverts the same inset.
export const PAD = 9;

export const stopCalc = (f) => `calc(${(f * 100).toFixed(3)}% + ${((1 - 2 * f) * PAD).toFixed(1)}px)`;
export const stopStyle = (f) => ({ left: stopCalc(f) });

export function fractionOf(index, count) {
  return count > 1 ? index / (count - 1) : 0;
}

export function nearestIndex(fraction, count) {
  if (count <= 1) return 0;
  const f = Math.min(1, Math.max(0, fraction));
  return Math.round(f * (count - 1));
}

export const isUltracode = (id) => id === "ultracode";
