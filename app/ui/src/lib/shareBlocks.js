// Structural sharing for the transcript's blocks. Every parse builds new block
// objects, so a memoized row would see a "new" block on each append. A block whose
// key and whole content equal the previous parse's keeps the previous object, and
// its row skips the render. Each previous object is handed out at most once, so two
// equal blocks never share one identity (identity-keyed maps stay one entry per row).
// The array itself is always the new one: what keys on the list's identity runs as before.

export function shareBlocks(prev, next, keyOf) {
  if (!prev || prev.length === 0) return next;
  const byKey = new Map();
  const ambiguous = new Set();
  prev.forEach((b, i) => {
    const k = keyOf(b, i);
    if (byKey.has(k)) ambiguous.add(k);
    else byKey.set(k, b);
  });
  const used = new Set();
  return next.map((b, i) => {
    const k = keyOf(b, i);
    const old = ambiguous.has(k) ? undefined : byKey.get(k);
    if (old === undefined || used.has(old) || !sameValue(old, b)) return b;
    used.add(old);
    return old;
  });
}

// Deep equality over the plain data blocks hold (objects, arrays, primitives).
export function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.prototype && Object.getPrototypeOf(a) !== null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !sameValue(a[k], b[k])) return false;
  }
  return true;
}
