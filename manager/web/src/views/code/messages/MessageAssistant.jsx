import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({
  breaks: true,
  gfm: true,
});

export function MessageAssistant({ text }) {
  const html = useMemo(() => {
    const raw = marked.parse(String(text || ""));
    return DOMPurify.sanitize(raw);
  }, [text]);

  return (
    <div
      className="msg-asst"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
