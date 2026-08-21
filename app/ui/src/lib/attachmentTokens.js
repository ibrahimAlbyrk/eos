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

// Snap an insertion offset out of the interior of any [label] token, so an
// inserted label can never split an existing one. Boundaries (start/end) are
// already safe and returned unchanged.
export function clampToTokenBoundary(text, pos, labels) {
  for (const r of findLabelRegions(text, labels)) {
    if (pos > r.start && pos < r.end) return r.end;
  }
  return pos;
}

// Splice attachment labels into `text` at `pos`, first clamping `pos` off any
// existing token interior. Returns the new text + the caret after the inserted
// run. Callers pass the LIVE editor text (read at insert time) so a deferred or
// rapid paste can never compute from a stale snapshot and clobber a sibling.
export function spliceLabels(text, pos, labels, existingLabels) {
  const at = clampToTokenBoundary(text, pos, existingLabels);
  const chunk = labels.map((l) => l + " ").join("");
  return { text: text.slice(0, at) + chunk + text.slice(at), caret: at + chunk.length };
}

// Labels whose token went from present in `prevText` to absent in `nextText` —
// a genuine deletion (select-all+delete, cut, a selection spanning the token).
// Inserts splice into live text and never drop a label, so they yield none.
export function labelsDeleted(prevText, nextText, labels) {
  return labels.filter((l) => prevText.includes(l) && !nextText.includes(l));
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

// Canonical parser now lives in contracts/src/attachments.ts (shared with the
// daemon's GET /workers/:id/attachments). Re-exported here so existing composer
// / message-bubble consumers keep importing from this module unchanged.
export { buildAttachmentSuffix, kindFromExt } from "../../../../contracts/src/attachments.ts";
import { parseAttachmentMessage as parseAttachmentMessageBase } from "../../../../contracts/src/attachments.ts";

// Element attachments (browser picker) carry an "(element)" annotation the
// canonical parser doesn't recognize — its kind union is image/file/folder, and
// the compact BrowserElement rides inline in the path-or-value slot:
//   - [label] (element): {"ref":…,"tag":…,"role":…,"name":…,"locator":…}
// So extend the parse here: pull element lines out, delegate the rest to the
// shared parser (single source of truth for image/file/folder + display split),
// then re-append the typed element entries. Non-element messages are delegated
// whole, so behaviour is unchanged for every existing consumer.
const ATTACH_MARKER = "\n\nattachments:\n";
const ELEMENT_LINE = /^-\s*(\[[^\]]+\])\s+\(element\):\s*(.+)$/;

export function parseAttachmentMessage(text) {
  const src = text ?? "";
  const idx = src.indexOf(ATTACH_MARKER);
  if (idx === -1) return parseAttachmentMessageBase(src);
  const elements = [];
  const kept = [];
  for (const line of src.slice(idx + ATTACH_MARKER.length).split("\n")) {
    const m = ELEMENT_LINE.exec(line);
    if (m) elements.push({ label: m[1], kind: "element", path: m[2].trim() });
    else kept.push(line);
  }
  if (elements.length === 0) return parseAttachmentMessageBase(src);
  const base = parseAttachmentMessageBase(src.slice(0, idx + ATTACH_MARKER.length) + kept.join("\n"));
  return { display: base.display, attachments: [...base.attachments, ...elements] };
}

// Compact-JSON element value → a short { tag, detail } for the chip / bubble.
// Null when the value isn't a parseable element payload.
export function elementSummary(value) {
  try {
    const el = JSON.parse(value);
    return { tag: el.tag || "element", detail: el.name || el.locator || el.role || "" };
  } catch {
    return null;
  }
}
