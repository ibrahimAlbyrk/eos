import { useMemo, useRef } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { useMermaid, useResolvedTheme } from "../../../hooks/useMermaid.js";
import { useMarkdownLinks } from "../../../hooks/useMarkdownLinks.js";

// Rendered (read) view for markdown files in the file panel. Uses the shared
// robust renderer (marked GFM + DOMPurify, cached), NOT MarkdownView.jsx's weak
// local parser. Renders into .md-prose — the SAME typography as a chat message
// (MessageAssistant) — wrapped in .fv-preview, which owns only the panel padding.
export function MarkdownPreview({ content, path }) {
  const ref = useRef(null);
  const html = useMemo(() => renderMarkdown(content ?? ""), [content]);
  const theme = useResolvedTheme();
  // Static file — no streaming gate; hydrate any mermaid fences immediately.
  useMermaid(ref, html, theme);
  // Relative .md links and #fragments open in-preview (never escape to the OS);
  // external links keep bubbling to the browser.
  useMarkdownLinks(ref, html, path);
  return (
    <div
      ref={ref}
      className="md-prose fv-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
