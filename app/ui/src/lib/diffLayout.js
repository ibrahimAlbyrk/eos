// Layout helpers for the Changes panel's diff: the unchanged stretch hidden
// before each hunk (a fold the reader can open) and the side-by-side pairing
// of a hunk's rows for split view. Pure — fed by lib/patch.js hunks.

// New-file line range [start, end] (1-based, inclusive) git left out before
// each hunk, or null when the hunk follows straight on.
export function foldGaps(hunks) {
  return hunks.map((h, i) => {
    const prev = hunks[i - 1];
    const start = prev ? prev.newStart + prev.newCount : 1;
    const end = h.newStart - 1;
    return end >= start ? { start, end } : null;
  });
}

// Rows paired for split view: context on both sides, each run of deletions
// zipped against the additions that follow it (extras face a blank). Every
// side keeps its row index `j` (token / word-diff lookups) and its line number.
export function splitPairs(hunk) {
  const out = [];
  const rows = hunk.rows;
  let oldNum = hunk.oldStart;
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.type === "ctx") {
      out.push({ left: { row: r, j: i, num: oldNum }, right: { row: r, j: i, num: r.num } });
      oldNum += 1;
      i += 1;
      continue;
    }
    const dels = [];
    while (i < rows.length && rows[i].type === "del") { dels.push({ row: rows[i], j: i, num: rows[i].num }); oldNum += 1; i += 1; }
    const adds = [];
    while (i < rows.length && rows[i].type === "add") { adds.push({ row: rows[i], j: i, num: rows[i].num }); i += 1; }
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}
