// Parses a unified git patch into hunks of render-ready rows. Single
// line-number gutter (matches the chat Edit cards): del rows carry the OLD
// line number, add/ctx rows the NEW one.
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch) {
  if (!patch) return [];
  const lines = patch.split("\n");
  // Final "\n" produces a phantom empty token — drop it, real patch lines
  // always start with a marker char.
  if (lines[lines.length - 1] === "") lines.pop();

  const hunks = [];
  let cur = null;
  let oldNum = 0;
  let newNum = 0;
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      oldNum = parseInt(m[1], 10);
      newNum = parseInt(m[2], 10);
      cur = { header: line, rows: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // file headers: diff --git, index, ---/+++, mode lines
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) cur.rows.push({ type: "add", num: newNum++, text: line.slice(1) });
    else if (line.startsWith("-")) cur.rows.push({ type: "del", num: oldNum++, text: line.slice(1) });
    else { cur.rows.push({ type: "ctx", num: newNum++, text: line.slice(1) }); oldNum++; }
  }
  return hunks;
}
