import { describe, it, expect } from "vitest";
import { makeLabel, labelTitle, findLabelRegions, findLabelAt, buildAttachmentSuffix } from "./attachmentTokens.js";

describe("makeLabel", () => {
  it("formats kind and index", () => {
    expect(makeLabel("image", 1)).toBe("{image #1}");
    expect(makeLabel("file", 12)).toBe("{file #12}");
  });
});

describe("labelTitle", () => {
  it("capitalizes the kind and keeps the index", () => {
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
    const text = "a {image #1} b {image #1} {file #2}";
    expect(findLabelRegions(text, ["{image #1}", "{file #2}"])).toEqual([
      { start: 2, end: 12 },
      { start: 15, end: 25 },
      { start: 26, end: 35 },
    ]);
  });

  it("returns empty for no matches", () => {
    expect(findLabelRegions("hello", ["{image #1}"])).toEqual([]);
  });
});

describe("findLabelAt", () => {
  const text = "x {image #1} y";
  it("hits inside and at end of token, misses at start boundary", () => {
    expect(findLabelAt(text, 3, ["{image #1}"])).toEqual({ start: 2, end: 12 });
    expect(findLabelAt(text, 12, ["{image #1}"])).toEqual({ start: 2, end: 12 });
    expect(findLabelAt(text, 2, ["{image #1}"])).toBeNull();
    expect(findLabelAt(text, 13, ["{image #1}"])).toBeNull();
  });
});

describe("buildAttachmentSuffix", () => {
  it("builds one mapping line per label with a known path", () => {
    const paths = new Map([["{image #1}", "/tmp/a.png"], ["{file #2}", "/tmp/b.txt"]]);
    expect(buildAttachmentSuffix(["{image #1}", "{file #2}"], paths)).toBe(
      "\n\nattachments:\n- {image #1}: /tmp/a.png\n- {file #2}: /tmp/b.txt"
    );
  });

  it("skips labels without a path and returns empty when none resolve", () => {
    const paths = new Map([["{image #1}", null]]);
    expect(buildAttachmentSuffix(["{image #1}"], paths)).toBe("");
    expect(buildAttachmentSuffix([], paths)).toBe("");
  });
});
