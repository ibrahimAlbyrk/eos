import { useMemo } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";

// Rendered (read) view for markdown files in the file panel. Uses the shared
// robust renderer (marked GFM + DOMPurify, cached), NOT MarkdownView.jsx's weak
// local parser. Output lands in .fv-markdown (shared with agent-result render).
export function MarkdownPreview({ content }) {
  const html = useMemo(() => renderMarkdown(content ?? ""), [content]);
  return <div className="fv-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
