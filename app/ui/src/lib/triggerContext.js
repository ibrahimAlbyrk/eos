export function isTriggerBoundary(text, idx) {
  return idx === 0 || text[idx - 1] === " " || text[idx - 1] === "\n";
}

// The word the cursor ends, when it starts with `char`: the fragment after
// that first `char` may hold more of it (`/apps/web:deploy`, `@a/@types/x`).
export function triggerContext(text, cursorPos, char) {
  const before = text.slice(0, cursorPos);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n")) + 1;
  if (before[start] !== char) return null;
  return { start, query: before.slice(start + 1).toLowerCase() };
}
