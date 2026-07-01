import { describe, it, expect } from "vitest";
import { withCopyButtons } from "./codeBlockCopy.js";
import { markdownToHtml } from "./markdown.js";

describe("withCopyButtons", () => {
  it("wraps a single fenced block and appends one copy button", () => {
    const html = markdownToHtml("```\nhello world\n```");
    const out = withCopyButtons(html);
    expect(out).toContain('<div class="code-block-wrap">');
    expect((out.match(/class="code-copy-btn"/g) || []).length).toBe(1);
    // original block is preserved verbatim inside the wrapper (copy text intact)
    expect(out).toContain("hello world");
    expect(out).toContain("<pre>");
  });

  it("adds exactly one button per block when several blocks are present", () => {
    const html = markdownToHtml("```\nA\n```\n\ntext\n\n```\nB\n```");
    const out = withCopyButtons(html);
    expect((out.match(/class="code-copy-btn"/g) || []).length).toBe(2);
    expect((out.match(/class="code-block-wrap"/g) || []).length).toBe(2);
  });

  it("leaves prose without code fences unchanged", () => {
    const html = markdownToHtml("just **bold** text, no code");
    expect(withCopyButtons(html)).toBe(html);
  });

  it("is a no-op on empty input", () => {
    expect(withCopyButtons("")).toBe("");
  });
});
