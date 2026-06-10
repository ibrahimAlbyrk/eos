import { describe, it, expect } from "vitest";
import { markdownToHtml } from "./markdown.js";

describe("markdownToHtml raw HTML escaping", () => {
  it("keeps everything after an unclosed inline <script> token", () => {
    const out = markdownToHtml(
      "Hard constraints: classic <script> tags only — NO ES modules.\n\nBuild:\n1. index.html + css/style.css",
    );
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("tags only");
    expect(out).toContain("index.html");
    expect(out).not.toMatch(/<script/);
  });

  it("escapes block-level raw HTML", () => {
    const out = markdownToHtml("<div>\nhello\n</div>");
    expect(out).toContain("&lt;div&gt;");
    expect(out).toContain("hello");
    expect(out).not.toMatch(/<div>/);
  });

  it("keeps generic-type tokens visible", () => {
    const out = markdownToHtml("returns Promise<string> on success");
    expect(out).toContain("Promise&lt;string&gt;");
  });

  it("leaves fenced code and normal markdown intact", () => {
    const out = markdownToHtml("**bold**\n\n```html\n<script>x</script>\n```");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<pre>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toMatch(/<script>/);
  });
});
