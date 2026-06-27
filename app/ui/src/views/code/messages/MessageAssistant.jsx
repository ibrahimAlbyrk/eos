import { useMemo, useRef } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { useBlurInReveal } from "../../../hooks/useBlurInReveal.js";

export function MessageAssistant({ text, animate = false, sessionId, blockId, onSettle }) {
  const ref = useRef(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useBlurInReveal(ref, html, animate, sessionId, blockId, onSettle);

  return (
    <div
      ref={ref}
      className="msg-asst md-prose"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
