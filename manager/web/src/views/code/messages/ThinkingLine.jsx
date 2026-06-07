import { useRef } from "react";
import { useBlurInReveal } from "../../../hooks/useBlurInReveal.js";

// Inline "thinking · ..." line rendered as part of the assistant's turn.
// No icon — the activity anchor under the latest message already signals
// motion; an extra icon here is visual noise.
// Blur-in mutates inside the ref span; safe because a thinking block's text
// is immutable (one event, no merge), so React never diffs those text nodes.
export function ThinkingLine({ text, animate = false }) {
  const ref = useRef(null);
  useBlurInReveal(ref, text, animate);
  return (
    <div className="thinking-line">
      <span className="mono">
        thinking{text ? <span ref={ref}>{` · ${text}`}</span> : null}
      </span>
    </div>
  );
}
