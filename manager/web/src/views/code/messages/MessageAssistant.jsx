import { useMemo, useRef } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useBlurInReveal } from "../../../hooks/useBlurInReveal.js";

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function MessageAssistant({ text, animate = false }) {
  const ref = useRef(null);
  const html = useMemo(() => {
    const raw = marked.parse(String(text || ""));
    return DOMPurify.sanitize(raw);
  }, [text]);

  useBlurInReveal(ref, html, animate);

  return (
    <div
      ref={ref}
      className="msg-asst"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
