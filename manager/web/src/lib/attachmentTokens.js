export function makeLabel(kind, n) {
  return `{${kind} #${n}}`;
}

// "{image #1}" → "Image #1" (null for non-label strings)
export function labelTitle(label) {
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

export function buildAttachmentSuffix(labels, paths) {
  const lines = [];
  for (const label of labels) {
    const path = paths.get(label);
    if (path) lines.push(`- ${label}: ${path}`);
  }
  return lines.length ? `\n\nattachments:\n${lines.join("\n")}` : "";
}
