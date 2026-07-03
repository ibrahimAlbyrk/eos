import { Marked } from "marked";
import DOMPurify from "dompurify";

export function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Raw HTML tokens are escaped, never passed through: an unclosed <script> or
// <style> in prose would otherwise swallow everything after it as raw text,
// which DOMPurify then strips wholesale — silently truncating the message.
const md = new Marked({
  breaks: true,
  gfm: true,
  renderer: {
    html(token) {
      return escapeHtml(token.raw);
    },
    // A ```mermaid fence becomes an inert placeholder; useMermaid hydrates it to
    // an SVG after injection (this pipeline is a string, so rendering can't
    // happen here). The source rides as the placeholder's escaped TEXT content,
    // not a data-* attribute: DOMPurify's mutation-XSS guard strips any attribute
    // whose value encodes '>', which every '-->' edge produces — so an attribute
    // would silently vanish under sanitize while an escaped text node survives.
    // The <pre class="mermaid-src"> loading shell also renders the raw source
    // immediately, so there is no flash of unstyled text before hydration.
    // Any other lang returns false → marked's default code path, preserving the
    // plain <pre><code> output for every non-mermaid fence.
    code({ text, lang }) {
      const info = (lang || "").match(/^\S*/)?.[0] || "";
      if (info !== "mermaid") return false;
      return `<div class="mermaid-block mermaid-loading"><pre class="mermaid-src">${escapeHtml(text)}</pre></div>`;
    },
  },
});

export function markdownToHtml(text) {
  return md.parse(String(text || ""));
}

// Bounded parse cache: a stable message renders to the same HTML every time, so
// re-mounting a transcript (first view of an agent) reuses the sanitized output
// instead of re-running marked + DOMPurify per block. Keyed by raw text; LRU by
// insertion order (mirrors lib/asyncHighlight.js).
const MAX_CACHE = 400;
const cache = new Map();

export function renderMarkdown(text) {
  const key = String(text || "");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(markdownToHtml(key));
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}
