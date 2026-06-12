import { describe, it, expect } from "vitest";
import { makeLabel, labelTitle, findLabelRegions, findLabelAt, buildAttachmentSuffix } from "./attachmentTokens.js";

describe("makeLabel", () => {
  it("brackets the name, truncating past 24 chars with an ellipsis", () => {
    expect(makeLabel("a.txt")).toBe("[a.txt]");
    expect(makeLabel("123456789012345678901234")).toBe("[123456789012345678901234]");
    expect(makeLabel("screenshot-2026-06-12-at-21.00.png")).toBe("[screenshot-2026-06-12-at…]");
  });

  it("appends the dedupe index past 1", () => {
    expect(makeLabel("a.txt", 2)).toBe("[a.txt 2]");
  });

  it("strips bracket chars and falls back on empty names", () => {
    expect(makeLabel("a[b]c")).toBe("[abc]");
    expect(makeLabel("")).toBe("[file]");
    expect(makeLabel(undefined)).toBe("[file]");
  });
});

describe("labelTitle", () => {
  it("unwraps bracket labels", () => {
    expect(labelTitle("[screensh…]")).toBe("screensh…");
    expect(labelTitle("[a.txt 2]")).toBe("a.txt 2");
  });

  it("keeps the legacy curly form", () => {
    expect(labelTitle("{image #1}")).toBe("Image #1");
    expect(labelTitle("{file #12}")).toBe("File #12");
  });

  it("returns null for non-label strings", () => {
    expect(labelTitle("/tmp/a.png")).toBeNull();
    expect(labelTitle(undefined)).toBeNull();
  });
});

describe("findLabelRegions", () => {
  it("finds every occurrence of every label", () => {
    const text = "a [img.png] b [img.png] [b.txt]";
    expect(findLabelRegions(text, ["[img.png]", "[b.txt]"])).toEqual([
      { start: 2, end: 11 },
      { start: 14, end: 23 },
      { start: 24, end: 31 },
    ]);
  });

  it("returns empty for no matches", () => {
    expect(findLabelRegions("hello", ["[img.png]"])).toEqual([]);
  });
});

describe("findLabelAt", () => {
  const text = "x [img.png] y";
  it("hits inside and at end of token, misses at start boundary", () => {
    expect(findLabelAt(text, 3, ["[img.png]"])).toEqual({ start: 2, end: 11 });
    expect(findLabelAt(text, 11, ["[img.png]"])).toEqual({ start: 2, end: 11 });
    expect(findLabelAt(text, 2, ["[img.png]"])).toBeNull();
    expect(findLabelAt(text, 12, ["[img.png]"])).toBeNull();
  });
});

describe("buildAttachmentSuffix", () => {
  it("builds one mapping line per label, annotating the kind when known", () => {
    const paths = new Map([["[a.png]", "/tmp/a.png"], ["[b.txt]", "/tmp/b.txt"]]);
    const kinds = new Map([["[a.png]", "image"]]);
    expect(buildAttachmentSuffix(["[a.png]", "[b.txt]"], paths, kinds)).toBe(
      "\n\nattachments:\n- [a.png] (image): /tmp/a.png\n- [b.txt]: /tmp/b.txt"
    );
  });

  it("skips labels without a path and returns empty when none resolve", () => {
    const paths = new Map([["[a.png]", null]]);
    expect(buildAttachmentSuffix(["[a.png]"], paths)).toBe("");
    expect(buildAttachmentSuffix([], paths)).toBe("");
  });
});
