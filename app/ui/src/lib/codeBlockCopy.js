// Copy affordance for fenced code blocks in rendered agent/worker markdown.
// withCopyButtons() wraps each <pre> emitted by the markdown renderer in a
// positioned container and appends a copy button; the click is handled via
// event delegation in MessageAssistant (DOMPurify strips inline handlers, so an
// onclick attribute would not survive — and the markup here is appended AFTER
// sanitization, so it stays trusted/static with no user content interpolated).
//
// The two icons are stacked in the button and toggled by the `.copied` class in
// CSS, mirroring the copy→check feedback of the message-row copy button.
const COPY_ICON =
  '<svg class="ccb-copy" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>';
const CHECK_ICON =
  '<svg class="ccb-check" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8.5 3 3 7-7"/></svg>';
const BUTTON = `<button type="button" class="code-copy-btn" aria-label="Copy code" title="Copy">${COPY_ICON}${CHECK_ICON}</button>`;

// marked emits each fenced block as a single, non-nested <pre>…</pre> (its
// contents are HTML-escaped, so no inner </pre> can appear) — a non-greedy
// match per block is therefore safe.
export function withCopyButtons(html) {
  if (!html || !html.includes("<pre")) return html;
  return html.replace(
    /<pre\b[\s\S]*?<\/pre>/g,
    (pre) => `<div class="code-block-wrap">${pre}${BUTTON}</div>`,
  );
}
