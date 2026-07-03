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

describe("markdownToHtml mermaid fences", () => {
  // The source rides as escaped TEXT content, not a data-* attribute: DOMPurify's
  // mutation-XSS guard strips any attribute whose value encodes '>', which every
  // '-->' edge produces. That stripping only reproduces in a real browser DOM
  // (WebKit/Chromium), NOT jsdom — so these assert the emit contract only;
  // sanitize survival is verified separately in headless Chromium/WebKit.
  it("emits an inert loading placeholder carrying the escaped source as text", () => {
    const out = markdownToHtml("```mermaid\ngraph TD; A-->B & \"C\"\n```");
    expect(out).toContain('class="mermaid-block mermaid-loading"');
    expect(out).toContain('<pre class="mermaid-src">');
    expect(out).not.toContain("data-mermaid-src");
    expect(out).toContain('A--&gt;B &amp; "C"');
  });

  it("round-trips a quoted, multi-line source: decoded text equals the source", () => {
    const src = 'graph TD\n  A["Kullanıcı isteği"] --> B["bye & <ok>"]';
    const out = markdownToHtml("```mermaid\n" + src + "\n```");
    const text = /<pre class="mermaid-src">([\s\S]*)<\/pre>/.exec(out)[1];
    // Mirrors the browser auto-decoding textContent performs on read.
    const decoded = text
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&");
    expect(decoded).toBe(src);
  });

  it("leaves non-mermaid fences on the default code path", () => {
    const out = markdownToHtml("```js\nconst a = 1;\n```");
    expect(out).toContain("<pre>");
    expect(out).toContain('class="language-js"');
    expect(out).not.toContain("mermaid-block");
  });
});
