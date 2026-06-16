// Pure markdown-list helpers over a flat string. Everything works in character
// offsets so the contentEditable cursor round-trip (range.toString() over a
// literal "\n") stays intact — no block DOM, no re-derived positions. The
// composer editor and the sent bubble share these so both read alike.

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/;

// One depth step = 2 leading spaces (the common markdown nesting unit).
const depthOf = (indent) => Math.floor(indent.length / 2);

function lineBounds(text, pos) {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  let end = text.indexOf("\n", pos);
  if (end === -1) end = text.length;
  return { start, end };
}

// Marker-glyph ranges for every list line: just the "-"/"*"/"1." token, not the
// trailing space. `ordered` keeps the literal number visible; unordered markers
// are overlaid with a bullet glyph in CSS.
export function listMarkers(text) {
  const out = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const m = LIST_RE.exec(line);
    if (m) {
      const start = lineStart + m[1].length;
      out.push({ start, end: start + m[2].length, depth: depthOf(m[1]), ordered: /\d/.test(m[2]) });
    }
    lineStart += line.length + 1;
  }
  return out;
}

function bumpOrdered(marker) {
  const n = parseInt(marker, 10);
  return n + 1 + marker.replace(/\d+/, "");
}

// Continue the list when the caret sits on a list line: a non-empty item splits
// at the caret and seeds the next marker; an empty item drops the marker to exit
// the list. Returns null off a list line so the caller keeps the default newline.
export function listContinuation(text, cursorPos) {
  const { start, end } = lineBounds(text, cursorPos);
  const m = LIST_RE.exec(text.slice(start, end));
  if (!m) return null;
  const contentAfter = text.slice(start + m[0].length, end);
  if (contentAfter.trim() === "" && cursorPos >= start + m[0].length) {
    return { text: text.slice(0, start) + text.slice(end), cursorPos: start };
  }
  const nextMarker = /\d/.test(m[2]) ? bumpOrdered(m[2]) : m[2];
  const insert = "\n" + m[1] + nextMarker + m[3];
  return { text: text.slice(0, cursorPos) + insert + text.slice(cursorPos), cursorPos: cursorPos + insert.length };
}

// Tab / Shift+Tab on a list line: indent or outdent one 2-space step. Returns
// null off a list line (or with nothing left to outdent) so Tab falls through.
export function listIndent(text, cursorPos, outdent) {
  const { start, end } = lineBounds(text, cursorPos);
  if (!LIST_RE.test(text.slice(start, end))) return null;
  if (outdent) {
    const remove = text.startsWith("  ", start) ? 2 : text.startsWith(" ", start) ? 1 : 0;
    if (!remove) return null;
    return { text: text.slice(0, start) + text.slice(start + remove), cursorPos: Math.max(start, cursorPos - remove) };
  }
  return { text: text.slice(0, start) + "  " + text.slice(start), cursorPos: cursorPos + 2 };
}
