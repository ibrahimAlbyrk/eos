import { isTriggerBoundary } from "./triggerContext.js";

// Single source for slash-command token matching: a token starts with "/" at
// a trigger boundary, runs to the next space/newline, and only counts when
// the name is a known command. Consumed by both the composer editor coloring
// and the message-bubble rich-text rule so the two surfaces can never drift.
export function findSlashTokens(text, names) {
  const tokens = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "/" || !isTriggerBoundary(text, i)) continue;
    let end = i + 1;
    while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
    const name = text.slice(i + 1, end);
    if (names.has(name)) tokens.push({ start: i, end, name });
    i = end - 1;
  }
  return tokens;
}
