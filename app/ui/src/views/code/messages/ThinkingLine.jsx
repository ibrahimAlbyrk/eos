import { useMemo, useRef } from "react";
import { escapeHtml } from "../../../lib/markdown.js";
import { useBlurInReveal } from "../../../hooks/useBlurInReveal.js";

// Inline reasoning line rendered as part of the assistant's turn — the raw
// reasoning text only, with no "thinking" label/prefix (the activity anchor
// under the latest message already signals motion).
//
// The text is set via innerHTML (escaped — reasoning is plain text, not markdown)
// rather than a React-managed text node, so the blur-in word-wrap survives while
// the text streams in token-by-token: React never reconciles inside
// dangerouslySetInnerHTML, so applyBlurIn's DOM mutation isn't fought. The durable
// block reuses this same instance by blockId, carrying the reveal state across the
// live -> durable handoff with no reflash.
export function ThinkingLine({ text, animate = false, sessionId, blockId, onSettle }) {
  const ref = useRef(null);
  const html = useMemo(() => (text ? escapeHtml(text) : ""), [text]);
  useBlurInReveal(ref, html, animate, sessionId, blockId, onSettle);
  return (
    <div className="thinking-line">
      <span className="mono">
        {html ? <span ref={ref} dangerouslySetInnerHTML={{ __html: html }} /> : null}
      </span>
    </div>
  );
}
