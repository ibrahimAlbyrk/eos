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

export function renderMarkdown(text) {
  return DOMPurify.sanitize(markdownToHtml(text));
}
