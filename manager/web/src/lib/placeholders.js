// {{label}} tab-stop placeholders for prompt templates. Pure text scanning —
// DOM selection lives in useContentEditableEditor; navigation order is
// document order with wrap-around.

const PLACEHOLDER_RE = /\{\{[^{}\n]*\}\}/g;

export function findPlaceholders(text) {
  const out = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    out.push({ start: m.index, end: m.index + m[0].length, label: m[0].slice(2, -2) });
  }
  return out;
}

/** First placeholder starting at/after `from`, wrapping to the first one. */
export function nextPlaceholder(placeholders, from) {
  if (placeholders.length === 0) return null;
  return placeholders.find((p) => p.start >= from) ?? placeholders[0];
}

/** Last placeholder ending at/before `from`, wrapping to the last one. */
export function prevPlaceholder(placeholders, from) {
  if (placeholders.length === 0) return null;
  for (let i = placeholders.length - 1; i >= 0; i--) {
    if (placeholders[i].end <= from) return placeholders[i];
  }
  return placeholders[placeholders.length - 1];
}
