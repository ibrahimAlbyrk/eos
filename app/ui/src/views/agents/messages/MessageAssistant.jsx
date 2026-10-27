import { useMemo, useRef } from "react";
import { renderMarkdown } from "../../../lib/markdown.js";
import { withCopyButtons } from "../../../lib/codeBlockCopy.js";
import { withArtifactChips } from "../../../lib/artifactLink.js";
import { useArtifactPeek } from "./ArtifactPeek.jsx";
import { useMermaid, useResolvedTheme } from "../../../hooks/useMermaid.js";
import { usePathChips } from "../../../hooks/usePathChips.js";
import { usePathPrefs } from "./paths/pathPrefs.js";

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

// `cwd` (the agent's folder) resolves the relative paths it names; the
// surrounding view's usePathLinks handles the chips they become.
export function MessageAssistant({ text, cwd = null }) {
  const ref = useRef(null);
  const prefs = usePathPrefs();
  const base = useMemo(() => withArtifactChips(withCopyButtons(renderMarkdown(text))), [text]);
  const html = usePathChips(base, cwd, { plainText: prefs.plainText, shorten: prefs.shorten, title: !prefs.peek });
  const theme = useResolvedTheme();
  const peek = useArtifactPeek();

  useMermaid(ref, html, theme);

  return (
    <>
      <div
        ref={ref}
        className="msg-asst md-prose"
        onClick={onCopyClick}
        {...peek.handlers}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {peek.layer}
    </>
  );
}
