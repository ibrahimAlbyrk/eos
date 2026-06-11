// Splits plain text into React nodes. Each rule decorates one kind of
// segment; rules apply in order and only ever touch the still-plain
// (string) pieces left by earlier rules — disjoint, order-independent
// for non-overlapping patterns like URLs vs {tokens}.
// A rule matches via `match` (a /g regex) or `scan` (text → [{start, end}],
// for token grammars a regex can't express, e.g. validated slash commands).
function matchesOf(node, rule) {
  if (rule.scan) return rule.scan(node).map(({ start, end }) => ({ index: start, text: node.slice(start, end) }));
  const out = [];
  for (const m of node.matchAll(rule.match)) out.push({ index: m.index, text: m[0] });
  return out;
}

function applyRule(node, rule, ri) {
  if (typeof node !== "string") return [node];
  const out = [];
  let last = 0;
  for (const m of matchesOf(node, rule)) {
    if (m.index > last) out.push(node.slice(last, m.index));
    out.push(rule.render(m.text, `r${ri}-${m.index}`));
    last = m.index + m.text.length;
  }
  if (last < node.length) out.push(node.slice(last));
  return out;
}

export function segment(text, rules) {
  return rules.reduce(
    (nodes, rule, ri) => nodes.flatMap((n) => applyRule(n, rule, ri)),
    [text],
  );
}

// http/https only; stops before trailing sentence punctuation/brackets.
export const URL_RE = /\bhttps?:\/\/[^\s<>]+[^\s<>.,;:!?'")\]}]/g;
