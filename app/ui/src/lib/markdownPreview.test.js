import { describe, it, expect } from "vitest";
import { isMarkdownPath } from "./markdownPreview.js";

describe("isMarkdownPath", () => {
  it("matches markdown extensions case-insensitively", () => {
    expect(isMarkdownPath("/a/README.md")).toBe(true);
    expect(isMarkdownPath("/a/notes.MARKDOWN")).toBe(true);
  });

  it("rejects non-markdown paths", () => {
    expect(isMarkdownPath("/a/main.ts")).toBe(false);
    expect(isMarkdownPath("/a/page.html")).toBe(false);
    expect(isMarkdownPath("/a/Makefile")).toBe(false);
  });
});
