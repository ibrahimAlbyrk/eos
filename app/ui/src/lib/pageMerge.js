import { diffArrays } from "diff";

// Three-way, line-based merge for a page the user edited while an agent changed
// it too: both sides' edits against the common base are applied when they touch
// different lines. null when they touch the same (or adjacent) lines — the
// caller then keeps the user's text.
export function mergePageBody(base, local, remote) {
  if (local === base) return remote;
  if (remote === base || remote === local) return local;
  const baseLines = base.split("\n");
  const mine = hunks(baseLines, local.split("\n"));
  const theirs = hunks(baseLines, remote.split("\n"));
  const all = [];
  for (const h of [...mine, ...theirs]) {
    const same = all.find((o) => o.start === h.start && o.end === h.end && o.lines.join("\n") === h.lines.join("\n"));
    if (same) continue;
    if (all.some((o) => clash(o, h))) return null;
    all.push(h);
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let at = 0;
  for (const h of all) {
    out.push(...baseLines.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...baseLines.slice(at));
  return out.join("\n");
}

// Changes as replacements of base line ranges [start, end) by `lines`.
function hunks(baseLines, otherLines) {
  const out = [];
  let at = 0;
  let cur = null;
  for (const part of diffArrays(baseLines, otherLines)) {
    if (!part.added && !part.removed) {
      if (cur) { out.push(cur); cur = null; }
      at += part.value.length;
      continue;
    }
    cur ??= { start: at, end: at, lines: [] };
    if (part.removed) { at += part.value.length; cur.end = at; } else cur.lines.push(...part.value);
  }
  if (cur) out.push(cur);
  return out;
}

// Overlapping ranges clash; so does an insertion at or inside the other's range.
function clash(a, b) {
  if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}
