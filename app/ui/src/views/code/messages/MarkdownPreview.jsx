import { useMemo } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";

// Rendered (read) view for markdown files in the file panel. Uses the shared
// robust renderer (marked GFM + DOMPurify, cached), NOT MarkdownView.jsx's weak
// local parser. Renders into .md-prose — the SAME typography as a chat message
// (MessageAssistant) — wrapped in .fv-preview, which owns only the panel padding.
export function MarkdownPreview({ content }) {
  const html = useMemo(() => renderMarkdown(content ?? ""), [content]);
  return <div className="md-prose fv-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
