// Pure relevance scoring for the command palette. Higher score = better match.
// Returns null when there is no match at all, so callers can drop the item.
// Centralizing match logic here keeps providers dumb (they only describe data)
// and makes scoring independently testable.

export function scoreMatch(query, text) {
  const q = query.toLowerCase();
  const t = (text || "").toLowerCase();
  if (!q) return 0;
  if (!t) return null;

  const idx = t.indexOf(q);
  if (idx !== -1) {
    const atWordStart = idx === 0 || /\s/.test(t[idx - 1]);
    return 2000 + (atWordStart ? 1000 : 0) - idx;
  }

  // Subsequence fallback: every query char appears in order, gaps penalized.
  let ti = 0, qi = 0, gaps = 0;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) qi++;
    else gaps++;
    ti++;
  }
  if (qi === q.length) return 500 - Math.min(gaps, 400);
  return null;
}
