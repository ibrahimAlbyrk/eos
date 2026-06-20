import { describe, it, expect } from "vitest";
import {
  shouldCollapsePaste,
  pasteLineCount,
  makePasteLabel,
  pastePreview,
  PASTE_RE,
  PASTE_LINE_THRESHOLD,
  PREVIEW_LINES,
} from "./pasteTokens.js";

const linesOf = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("shouldCollapsePaste", () => {
  it("leaves a paste at the threshold inline", () => {
    expect(shouldCollapsePaste(linesOf(PASTE_LINE_THRESHOLD))).toBe(false);
  });
  it("collapses one line past the threshold", () => {
    expect(shouldCollapsePaste(linesOf(PASTE_LINE_THRESHOLD + 1))).toBe(true);
  });
  it("never collapses a single huge line (line-based)", () => {
    expect(shouldCollapsePaste("x".repeat(10000))).toBe(false);
  });
});

describe("makePasteLabel ↔ PASTE_RE round-trip", () => {
  it("pluralizes and is matched by the bubble matcher", () => {
    const label = makePasteLabel(96, 92);
    expect(label).toBe("[Pasted text #96 +92 lines]");
    expect(`hi ${label} bye`.match(PASTE_RE)).toEqual([label]);
  });
  it("uses the singular form for one line", () => {
    expect(makePasteLabel(1, 1)).toBe("[Pasted text #1 +1 line]");
    expect(makePasteLabel(1, 1).match(PASTE_RE)).toEqual(["[Pasted text #1 +1 line]"]);
  });
  it("matches several placeholders in one string", () => {
    const a = makePasteLabel(1, 7);
    const b = makePasteLabel(2, 40);
    expect(`${a} and ${b}`.match(PASTE_RE)).toEqual([a, b]);
  });
});

describe("pastePreview", () => {
  it("returns short text untouched", () => {
    expect(pastePreview("a\nb\nc")).toBe("a\nb\nc");
  });
  it("truncates past PREVIEW_LINES with an ellipsis", () => {
    const preview = pastePreview(linesOf(PREVIEW_LINES + 5));
    expect(preview.split("\n")).toHaveLength(PREVIEW_LINES + 1);
    expect(preview.endsWith("\n…")).toBe(true);
  });
});

describe("pasteLineCount", () => {
  it("counts lines", () => {
    expect(pasteLineCount("a\nb\nc")).toBe(3);
    expect(pasteLineCount("")).toBe(1);
  });
});
