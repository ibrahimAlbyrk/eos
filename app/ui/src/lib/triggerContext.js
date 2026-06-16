export function isTriggerBoundary(text, idx) {
  return idx === 0 || text[idx - 1] === " " || text[idx - 1] === "\n";
}

export function triggerContext(text, cursorPos, char) {
  const before = text.slice(0, cursorPos);
  const idx = before.lastIndexOf(char);
  if (idx === -1 || !isTriggerBoundary(before, idx)) return null;
  const fragment = before.slice(idx + 1);
  if (fragment.includes(" ") || fragment.includes("\n")) return null;
  return { start: idx, query: fragment.toLowerCase() };
}
