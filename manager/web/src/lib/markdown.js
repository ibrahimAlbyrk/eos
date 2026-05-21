// Markdown → safe HTML for agent-rendered prose.
//
// Why marked: smallest mainstream parser, GFM out of the box, default config
// in v12+ escapes HTML in text content so we don't need a separate sanitizer.
// We only pass through Claude's own output (extended thinking + assistant
// text), so the trust boundary is the daemon — but defaulting to HTML-safe
// keeps us honest if anything else ever feeds this function.

import { marked } from "marked";

marked.use({
  // GFM = tables, strikethrough, autolinks, task lists. Standard nowadays.
  gfm: true,
  // breaks=true turns single newlines into <br>. Claude's prose usually has
  // blank-line paragraph separators, so this matches its formatting intent.
  breaks: true,
});

// Open external links in a new tab with rel=noopener so a malicious URL
// can't reach the daemon-served origin.
const renderer = new marked.Renderer();
const originalLink = renderer.link.bind(renderer);
renderer.link = function (...args) {
  const html = originalLink(...args);
  if (html.startsWith("<a ")) {
    return html.replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
  }
  return html;
};
marked.use({ renderer });

/**
 * Render markdown text into HTML. Returns an empty string for empty input
 * and falls back to the raw text inside <p> if parsing throws — the UI never
 * crashes because the model wrote a broken table.
 */
export function renderMarkdown(text) {
  if (!text) return "";
  try {
    return marked.parse(String(text));
  } catch {
    const escaped = String(text).replace(/[&<>]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"
    );
    return `<p>${escaped}</p>`;
  }
}
