// Inline markdown from the agent, sanitized by lib/markdown.js (raw HTML is
// escaped, DOMPurify strips the rest). Links open through the view runtime.

import { useMemo } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { useView } from "../../runtime/ViewContext.jsx";
import { cls, interceptLinks } from "./util.js";

export function Markdown({ text, className, as: Tag = "div" }) {
  const view = useView();
  const html = useMemo(() => (text ? renderMarkdown(String(text)) : ""), [text]);
  if (!html) return null;
  return <Tag className={cls("gv-md", className)} onClick={interceptLinks(view)} dangerouslySetInnerHTML={{ __html: html }} />;
}
