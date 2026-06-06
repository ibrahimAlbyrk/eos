export const ESC_CHORD_WINDOW_MS = 500;

export function escChord(lastTs, now, windowMs = ESC_CHORD_WINDOW_MS) {
  return { isDouble: now - lastTs <= windowMs, ts: now };
}
