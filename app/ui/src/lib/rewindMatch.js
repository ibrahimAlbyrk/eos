// Maps a rendered chat bubble back to its transcript rewind target. Targets
// come from GET /workers/:id/rewind-targets (active-branch user prompts);
// chat blocks carry only text, so matching is by normalized content with the
// same either-way prefix tolerance as messageParser's findRewindCut
// (attachments append suffixes). `occurrence` disambiguates duplicate texts:
// it is the bubble's index among same-text bubbles, oldest first. Strict on
// overflow — rewinding to the wrong point is worse than failing.

export const normRewindText = (s) => (s ?? "").replace(/\s+/g, " ").trim();
const norm = normRewindText;

export function findRewindTarget(targets, text, occurrence = 0) {
  const needle = norm(text);
  if (!needle) return null;
  const score = (t) =>
    [norm(t.text), norm(t.display)].reduce((best, x) => {
      if (!x) return best;
      if (x === needle) return Math.max(best, 2);
      if (x.startsWith(needle) || needle.startsWith(x)) return Math.max(best, 1);
      return best;
    }, 0);
  const exact = [];
  const prefix = [];
  for (const t of targets ?? []) {
    const s = score(t);
    if (s === 2) exact.push(t);
    else if (s === 1) prefix.push(t);
  }
  const matches = exact.length > 0 ? exact : prefix;
  return matches[occurrence] ?? null;
}
