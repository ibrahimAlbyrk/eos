// Long pasted text is collapsed in the composer into a "[Pasted text #N +M
// lines]" pill — the placeholder lives as literal text in the model string
// (like an attachment label), so the same generic findLabelRegions/findLabelAt
// machinery colorizes and deletes it. The full text is held out-of-band in the
// composer's pastesRef and spliced back in only at send (like an @path's
// absolute form). This module is the single source for the label format /
// threshold / matcher, shared by the composer editor and the message bubble so
// the two surfaces can never drift (mirrors slashTokens.js / attachmentTokens.js).

// Collapse pastes taller than this — line-based to match the "+M lines" label.
export const PASTE_LINE_THRESHOLD = 6;

export function pasteLineCount(text) {
  return (text ?? "").split("\n").length;
}

export function shouldCollapsePaste(text) {
  return pasteLineCount(text) > PASTE_LINE_THRESHOLD;
}

export function makePasteLabel(n, lines) {
  return `[Pasted text #${n} +${lines} line${lines === 1 ? "" : "s"}]`;
}

// Self-contained matcher for the message bubble, which has no pastesRef — the
// placeholder is recognized by shape alone. Kept beside makePasteLabel so the
// writer and reader never drift.
export const PASTE_RE = /\[Pasted text #\d+ \+\d+ lines?\]/g;

// First PREVIEW_LINES lines for the composer hover card; longer text trails off.
export const PREVIEW_LINES = 12;

export function pastePreview(text) {
  const lines = (text ?? "").split("\n");
  const head = lines.slice(0, PREVIEW_LINES).join("\n");
  return lines.length > PREVIEW_LINES ? head + "\n…" : head;
}
