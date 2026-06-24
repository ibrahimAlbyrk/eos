// Whether a queued pendingText should overwrite the editor's current content.
//
// A recall restore (interrupt-before-response → text returned to the composer)
// carries guard:"recall" and must NOT clobber a draft the user typed after
// sending — only restore into an empty editor. Rewind restores (no guard) always
// replace, preserving the existing behavior. In practice a recall arrives with
// an empty editor (the send cleared it, and the composer's own Esc handler eats
// Esc while a draft exists), so this guard is the belt-and-suspenders case.
export function shouldApplyPendingText(pendingText, currentText) {
  if (!pendingText) return false;
  if (pendingText.guard === "recall" && (currentText ?? "").trim()) return false;
  return true;
}
