import { useMemo, useRef } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { useBlurInReveal } from "../../../hooks/useBlurInReveal.js";

export function MessageAssistant({ text, animate = false }) {
  const ref = useRef(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useBlurInReveal(ref, html, animate);

  return (
    <div
      ref={ref}
      className="msg-asst"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
