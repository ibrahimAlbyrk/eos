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

// Reconcile chip items to the labels a (restored) text contains: keep items
// whose label survives, re-seat known labels the text regained (status from the
// resolved path / in-flight job, else skip), drop the rest. Returns `prev`
// unchanged when nothing moves so a setItems caller can no-op. Pure → testable.
export function reconcileAttachmentItems(prev, text, { usedLabels, paths, kinds, pending }) {
  const kept = prev.filter((it) => text.includes(it.label));
  const present = new Set(kept.map((it) => it.label));
  const added = [];
  for (const label of usedLabels) {
    if (present.has(label) || !text.includes(label)) continue;
    const kind = kinds.get(label) ?? "file";
    const path = paths.get(label);
    if (path) added.push({ label, kind, path, status: "ready" });
    else if (pending.has(label)) added.push({ label, kind, path: null, status: "uploading" });
  }
  if (!added.length && kept.length === prev.length) return prev;
  return [...kept, ...added];
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

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

function kindFromExt(path) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext) ? "image" : "file";
}

// Inverse of buildAttachmentSuffix — kept beside it so reader and writer never
// drift. Splits the "attachments:" suffix off a sent message into the display
// text + a typed list: { display, attachments: [{ label?, kind, path }] }.
// Tolerates the legacy "{image #1}" / bare "image:" forms and infers kind from
// the extension when the "(kind)" annotation is absent. Pure → testable, and
// shared by the message bubble (render) and the composer (paste reconstruction).
export function parseAttachmentMessage(text) {
  const marker = "\n\nattachments:\n";
  const idx = (text ?? "").indexOf(marker);
  if (idx === -1) return { display: text ?? "", attachments: [] };
  const display = text.slice(0, idx);
  const attachments = text.slice(idx + marker.length)
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean)
    .map((raw) => {
      const bracket = raw.match(/^(\[[^\]]+\])(?:\s+\((image|file|folder)\))?:\s*(.+)$/);
      if (bracket) return { label: bracket[1], kind: bracket[2] ?? kindFromExt(bracket[3]), path: bracket[3] };
      const labeled = raw.match(/^(\{(image|file|folder) #\d+\}):\s*(.+)$/);
      if (labeled) return { label: labeled[1], kind: labeled[2], path: labeled[3] };
      const bare = raw.match(/^(folder|file|image):\s*(.+)$/);
      if (bare) return { kind: bare[1], path: bare[2] };
      return { kind: kindFromExt(raw), path: raw };
    });
  return { display, attachments };
}
