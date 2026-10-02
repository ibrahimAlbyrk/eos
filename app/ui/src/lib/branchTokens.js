import { isTriggerBoundary } from "./triggerContext.js";

// Trailing sentence punctuation is not part of a reference, so "#dev," or
// "(see #main)." still count as `dev` / `main` mid-sentence.
const TRAILING_PUNCT = /[.,;:!?)]+$/;

// `#branch` references: "#" at a trigger boundary followed by a known branch
// name. Like slash commands, a token only counts while the name is a real
// branch — the composer's coloring, atomic caret and send expansion all read it.
export function findBranchTokens(text, names) {
  const tokens = [];
  if (!names?.size) return tokens;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "#" || !isTriggerBoundary(text, i)) continue;
    let end = i + 1;
    while (end < text.length && text[end] !== " " && text[end] !== "\n") end++;
    const run = text.slice(i + 1, end);
    const name = names.has(run) ? run : run.replace(TRAILING_PUNCT, "");
    if (name && names.has(name)) tokens.push({ start: i, end: i + 1 + name.length, name });
    i = end - 1;
  }
  return tokens;
}

// What the agent receives in place of `#name` (the chat bubble keeps `#name`):
// spelled out so the model knows it is a git branch, not a hashtag or issue.
export function expandBranchRefs(text, names) {
  let out = "";
  let last = 0;
  for (const t of findBranchTokens(text, names)) {
    out += text.slice(last, t.start) + `\`${t.name}\` (git branch)`;
    last = t.end;
  }
  return out + text.slice(last);
}
