import { findSlashTokens } from "./slashTokens.js";
import { findLabelRegions } from "./attachmentTokens.js";
import { findPlaceholders } from "./placeholders.js";

// Single source of truth for "where are the tokens in the composer model text".
// Coloring (useContentEditableEditor) and atomic delete (Composer) historically
// each re-scanned the string; this is the one model the NEW atomic caret /
// click-select / hover behaviors read from, so a token's boundaries are computed
// once. Each region is { start, end, kind, key, atomic }.
//
//   kind 'cmd'         — /slash command   (atomic)
//   kind 'path'        — @file mention    (atomic)
//   kind 'paste'       — [Pasted text #N] (atomic)
//   kind 'attachment'  — [label]          (atomic)
//   kind 'placeholder' — {{field}}        (NOT atomic — typed-over for templates)
//
// ctx = { slashNames, paths, pasteKeys, attachmentLabels } — `paths` are the
// @-mention display strings (the "@" prefix is added here); `slashNames` is any
// collection with `.has(name)` (the same set coloring uses, so atomicity matches
// the blue rendering, not the narrower delete set).
export function tokenRegions(text, ctx = {}) {
  const { slashNames, paths = [], pasteKeys = [], attachmentLabels = [] } = ctx;
  const regions = [];

  if (slashNames) {
    for (const t of findSlashTokens(text, slashNames)) {
      regions.push({ start: t.start, end: t.end, kind: "cmd", key: t.name, atomic: true });
    }
  }

  for (const display of paths) {
    const token = "@" + display;
    let idx = 0;
    while ((idx = text.indexOf(token, idx)) !== -1) {
      regions.push({ start: idx, end: idx + token.length, kind: "path", key: display, atomic: true });
      idx += token.length;
    }
  }

  for (const r of findLabelRegions(text, pasteKeys)) {
    regions.push({ start: r.start, end: r.end, kind: "paste", key: text.slice(r.start, r.end), atomic: true });
  }

  for (const r of findLabelRegions(text, attachmentLabels)) {
    regions.push({ start: r.start, end: r.end, kind: "attachment", key: text.slice(r.start, r.end), atomic: true });
  }

  for (const p of findPlaceholders(text)) {
    regions.push({ start: p.start, end: p.end, kind: "placeholder", key: p.label, atomic: false });
  }

  return dedupeSorted(regions);
}

// Sort by start (longer first on ties) and drop any region that overlaps one
// already kept — mirrors colorize's "skip r.start < last" rule so the region set
// is non-overlapping, the precondition every consumer assumes.
function dedupeSorted(regions) {
  regions.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let last = -1;
  for (const r of regions) {
    if (r.start < last) continue;
    out.push(r);
    last = r.end;
  }
  return out;
}

// The atomic token straddling a caret/hit `pos`. interiorOnly:true means a
// strict interior hit (start < pos < end) — used for click-to-select so a click
// exactly on a boundary still places a plain caret there. Otherwise start < pos
// <= end (the same half-open rule the Backspace delete uses).
export function tokenAt(regions, pos, { interiorOnly = false, atomicOnly = true } = {}) {
  for (const r of regions) {
    if (atomicOnly && !r.atomic) continue;
    if (interiorOnly ? r.start < pos && pos < r.end : r.start < pos && pos <= r.end) return r;
  }
  return null;
}

// Where an Arrow keypress should land so it jumps a whole token in one step,
// or null when no token straddles the step (caller does the native char move).
//   right: a region with start <= pos < end  →  end   (skip forward over it)
//   left:  a region with start < pos <= end   →  start (skip backward over it)
export function atomicCaretTarget(regions, pos, dir) {
  for (const r of regions) {
    if (!r.atomic) continue;
    if (dir === "right" && r.start <= pos && pos < r.end) return r.end;
    if (dir === "left" && r.start < pos && pos <= r.end) return r.start;
  }
  return null;
}
