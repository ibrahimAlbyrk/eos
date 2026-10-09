// Step-through navigation for <Steps variant="stepper">, kept pure for tests.

export function clampStep(index, total) {
  const n = Math.trunc(Number(index));
  if (!Number.isFinite(n) || total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, n));
}

// dir: -1 back, +1 next; stays put at the ends.
export function stepNav(index, total, dir) {
  return clampStep(clampStep(index, total) + (dir < 0 ? -1 : 1), total);
}

export function stepFlags(index, total) {
  const i = clampStep(index, total);
  return { index: i, atStart: i === 0, atEnd: i >= total - 1, label: `Step ${total ? i + 1 : 0} / ${total}` };
}

// The progress dots: the current one wide, done ones in tone.
export function stepDots(index, total) {
  const i = clampStep(index, total);
  return Array.from({ length: total }, (_, k) => ({ current: k === i, done: k <= i }));
}
