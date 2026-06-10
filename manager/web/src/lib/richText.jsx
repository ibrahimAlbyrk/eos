// Splits plain text into React nodes. Each rule decorates one kind of
// segment; rules apply in order and only ever touch the still-plain
// (string) pieces left by earlier rules — disjoint, order-independent
// for non-overlapping patterns like URLs vs {tokens}.
function applyRule(node, rule, ri) {
  if (typeof node !== "string") return [node];
  const out = [];
  let last = 0;
  for (const m of node.matchAll(rule.match)) {
    if (m.index > last) out.push(node.slice(last, m.index));
    out.push(rule.render(m[0], `r${ri}-${m.index}`));
    last = m.index + m[0].length;
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
