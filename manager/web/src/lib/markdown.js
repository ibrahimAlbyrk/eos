import { Marked } from "marked";
import DOMPurify from "dompurify";

function escapeHtml(s) {
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
