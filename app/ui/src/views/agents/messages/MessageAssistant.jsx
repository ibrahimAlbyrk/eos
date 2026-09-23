import { useMemo, useRef } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { withCopyButtons } from "../../../lib/codeBlockCopy.js";
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

export function MessageAssistant({ text }) {
  const ref = useRef(null);
  const html = useMemo(() => withCopyButtons(renderMarkdown(text)), [text]);
  const theme = useResolvedTheme();

  useMermaid(ref, html, theme);

  return (
    <div
      ref={ref}
      className="msg-asst md-prose"
      onClick={onCopyClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
