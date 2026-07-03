import { useCallback, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { withCopyButtons } from "../../../lib/codeBlockCopy.js";
import { useBlurInReveal } from "../../../hooks/useBlurInReveal.js";
import { useMermaid, useResolvedTheme } from "../../../hooks/useMermaid.js";

// Copies the raw text of one code block when its injected copy button is
// clicked. Delegated from the prose container because the buttons live in
// dangerouslySetInnerHTML (no React onClick of their own). Reads textContent of
// the block's <code> at click time so the copied text is exactly that block's
// source — no surrounding chrome, no other blocks.
function onCopyClick(e) {
  const btn = e.target.closest(".code-copy-btn");
  if (!btn) return;
  const pre = btn.closest(".code-block-wrap")?.querySelector("pre");
  const text = (pre?.querySelector("code") ?? pre)?.textContent ?? "";
  if (!navigator.clipboard?.writeText) return;
  navigator.clipboard.writeText(text).then(
    () => {
      btn.classList.add("copied");
      setTimeout(() => btn.classList.remove("copied"), 1500);
    },
    () => {},
  );
}

export function MessageAssistant({ text, animate = false, sessionId, blockId, onSettle }) {
  const ref = useRef(null);
  const html = useMemo(() => withCopyButtons(renderMarkdown(text)), [text]);
  const theme = useResolvedTheme();

  // Gate mermaid on the blur-in reveal: a non-animating message is settled from
  // the start; an animating one settles when the reveal completes, so a diagram
  // that is still mid-stream keeps its raw source instead of flashing an error.
  const [settled, setSettled] = useState(!animate);
  const handleSettle = useCallback(() => { setSettled(true); onSettle?.(); }, [onSettle]);

  useBlurInReveal(ref, html, animate, sessionId, blockId, handleSettle);
  useMermaid(ref, html, theme, { gate: settled });

  return (
    <div
      ref={ref}
      className="msg-asst md-prose"
      onClick={onCopyClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
