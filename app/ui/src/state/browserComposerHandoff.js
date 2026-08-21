// browserComposerHandoff — a pane-keyed one-shot hand-off from the browser
// panel's annotation overlay to that pane's message composer. The overlay's
// "Add to chat" uploads the composited image, then pushes the resulting
// attachment here keyed by PANE id; the composer that owns that pane consumes
// it exactly once (subscribe → intake.addAttachments → consume). Module
// singleton in the recallStore shape (subscribe/get/push/consume/_reset) so the
// owning Composer reads it directly — no selection detour. Nothing exports
// addAttachments across panes, so this is the seam. The browser panel and the
// composer in one pane share the same paneId (both take the pane's leaf id), so
// the key routes the image to the right composer in a split layout.

let seq = 0;
const entries = new Map(); // paneId -> { token, attachments: [{ type, path }] }
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getHandoff(paneId) {
  return entries.get(paneId) ?? null;
}

// A fresh hand-off supersedes any un-consumed prior one for the same pane.
// `token` is a distinct identity so the owner clears exactly the one it applied
// (a newer hand-off landing mid-apply is never dropped by a stale consume).
export function pushHandoff(paneId, attachments) {
  if (!paneId || !attachments?.length) return;
  entries.set(paneId, { token: `bh-${++seq}`, attachments });
  emit();
}

// Clear iff `token` is still the live hand-off for the pane — the owning
// composer calls this the instant it applies, so a re-render or reselect never
// re-injects the same image.
export function consumeHandoff(paneId, token) {
  const e = entries.get(paneId);
  if (e && e.token === token) {
    entries.delete(paneId);
    emit();
  }
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  entries.clear();
  seq = 0;
  subs.clear();
}
