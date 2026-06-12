// Attachment tokens live as literal text in the composer ("[report.p…]"),
// so the label doubles as the unique key for paths/kinds maps — `n` suffixes
// disambiguate same-named files ("[a.txt 2]").
const MAX_NAME_CHARS = 24;

export function makeLabel(name, n = 1) {
  const clean = (name ?? "").replace(/[[\]\n]/g, "").trim() || "file";
  const chars = Array.from(clean);
  const short = chars.length > MAX_NAME_CHARS ? chars.slice(0, MAX_NAME_CHARS).join("") + "…" : clean;
  return n > 1 ? `[${short} ${n}]` : `[${short}]`;
}

// "[report.p…]" → "report.p…"; legacy "{image #1}" → "Image #1" (old sent
// messages still carry the curly form). Null for non-label strings.
export function labelTitle(label) {
  const bracket = /^\[(.+)\]$/.exec(label ?? "");
  if (bracket) return bracket[1];
  const m = /^\{(\w+) #(\d+)\}$/.exec(label ?? "");
  if (!m) return null;
  return m[1][0].toUpperCase() + m[1].slice(1) + " #" + m[2];
}

export function findLabelRegions(text, labels) {
  const regions = [];
  for (const label of labels) {
    let idx = 0;
    while ((idx = text.indexOf(label, idx)) !== -1) {
      regions.push({ start: idx, end: idx + label.length });
      idx += label.length;
    }
  }
  return regions;
}

export function findLabelAt(text, pos, labels) {
  for (const r of findLabelRegions(text, labels)) {
    if (pos > r.start && pos <= r.end) return r;
  }
  return null;
}

// The "(kind)" annotation lets the message bubble pick the right chip icon
// when re-parsing the sent text (a path alone can't distinguish folders).
export function buildAttachmentSuffix(labels, paths, kinds) {
  const lines = [];
  for (const label of labels) {
    const path = paths.get(label);
    if (!path) continue;
    const kind = kinds?.get(label);
    lines.push(kind ? `- ${label} (${kind}): ${path}` : `- ${label}: ${path}`);
  }
  return lines.length ? `\n\nattachments:\n${lines.join("\n")}` : "";
}
