// The summarizer writes numbered sections ("1. Primary Request and Intent:" …,
// see manager/prompts/compaction/summarize). Split them so the card can hang
// each on its constellation line. Headings must count up from 1 — a numbered
// item inside a section body never starts a new section. Text that doesn't
// follow the shape stays one untitled section.
export function summarySections(summary) {
  const out = [];
  let cur = null;
  for (const line of (summary ?? "").split("\n")) {
    const m = /^\s{0,3}(\d+)\.\s+([^:\n]{2,60}):\s*(.*)$/.exec(line);
    const titled = out.filter((s) => s.title).length;
    if (m && Number(m[1]) === titled + 1) {
      cur = { title: m[2].trim(), lines: m[3] ? [m[3]] : [] };
      out.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: null, lines: [] };
      out.push(cur);
    }
    cur.lines.push(line);
  }
  return out
    .map((s) => ({ title: s.title, body: dedent(s.lines).trim() }))
    .filter((s) => s.title || s.body);
}

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length);
  const n = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(n)).join("\n");
}
