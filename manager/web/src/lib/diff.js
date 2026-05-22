// Line- and word-level diff for Edit/MultiEdit/NotebookEdit blocks.
//
// Returns a row-stream the renderer can map 1:1 into the diff table.
// Each row carries its source line numbers (old/new) so the renderer can
// print a GitHub-style "old | new | sign | content" gutter.
//
// Word-level segments live on the kind:"replace" pair: the deleted line's
// `segments` highlight removed tokens, the added line's `segments` highlight
// inserted tokens. This lets the UI dim unchanged token spans on a modified
// line so the eye lands on the actual change.

import { diffLines, diffWordsWithSpace } from "diff";

function splitLines(s) {
  if (s == null) return [];
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  return trimmed.length === 0 ? [""] : trimmed.split("\n");
}

// diffWordsWithSpace is O(N*M). Above this combined length we skip the
// word-level highlight and let the row render as a plain del/add pair —
// keeps the UI responsive on long single-line edits (minified bundles,
// package-lock.json) where the per-token annotation isn't useful anyway.
const WORD_DIFF_LIMIT = 4000;

// Build word-level segments aligned to the deleted line and the added line.
// Same diff fed both rows; on the del row we keep "removed" + "common", on
// the add row we keep "added" + "common".
function pairSegments(oldLine, newLine) {
  if (oldLine.length + newLine.length > WORD_DIFF_LIMIT) return null;
  const parts = diffWordsWithSpace(oldLine, newLine);
  const del = [];
  const add = [];
  for (const p of parts) {
    if (p.removed) del.push({ kind: "change", text: p.value });
    else if (p.added) add.push({ kind: "change", text: p.value });
    else { del.push({ kind: "same", text: p.value }); add.push({ kind: "same", text: p.value }); }
  }
  return { del, add };
}

// Group an array of rows into hunks separated by gaps in context.
// `contextRadius` controls how many unchanged lines stay around each change.
function condenseToHunks(rows, contextRadius = 3) {
  const changeIdx = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].kind !== "context") changeIdx.push(i);
  if (changeIdx.length === 0) return [];
  const hunks = [];
  let curStart = Math.max(0, changeIdx[0] - contextRadius);
  let curEnd = Math.min(rows.length - 1, changeIdx[0] + contextRadius);
  for (let i = 1; i < changeIdx.length; i++) {
    const k = changeIdx[i];
    const from = Math.max(0, k - contextRadius);
    const to = Math.min(rows.length - 1, k + contextRadius);
    if (from <= curEnd + 1) {
      curEnd = Math.max(curEnd, to);
    } else {
      hunks.push(rows.slice(curStart, curEnd + 1));
      curStart = from;
      curEnd = to;
    }
  }
  hunks.push(rows.slice(curStart, curEnd + 1));
  return hunks;
}

export function diffLinesUnified(oldStr, newStr, { contextRadius = 3 } = {}) {
  const parts = diffLines(oldStr ?? "", newStr ?? "");
  const rows = [];
  let oldNo = 1, newNo = 1, addCount = 0, delCount = 0;

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const lines = splitLines(p.value);
    const next = parts[i + 1];

    // Pair adjacent (-) (+) hunks of equal length so we can attach
    // word-level segments to each row, exposing the precise change.
    if (p.removed && next?.added) {
      const delLines = lines;
      const addLines = splitLines(next.value);
      const n = Math.min(delLines.length, addLines.length);
      for (let k = 0; k < n; k++) {
        const segs = pairSegments(delLines[k], addLines[k]);
        rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: delLines[k], segments: segs?.del });
        rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: addLines[k], segments: segs?.add });
        delCount++; addCount++;
      }
      for (let k = n; k < delLines.length; k++) {
        rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: delLines[k] });
        delCount++;
      }
      for (let k = n; k < addLines.length; k++) {
        rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: addLines[k] });
        addCount++;
      }
      i++; // consume the paired (+) hunk
      continue;
    }

    if (p.removed) {
      for (const line of lines) {
        rows.push({ kind: "del", oldNo: oldNo++, newNo: null, text: line });
        delCount++;
      }
      continue;
    }
    if (p.added) {
      for (const line of lines) {
        rows.push({ kind: "add", oldNo: null, newNo: newNo++, text: line });
        addCount++;
      }
      continue;
    }
    for (const line of lines) {
      rows.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: line });
    }
  }

  const hunks = condenseToHunks(rows, contextRadius);
  return { rows, hunks, stats: { add: addCount, del: delCount } };
}
