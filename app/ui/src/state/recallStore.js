// recallStore — the ephemeral "interrupt-before-response" recall: the just-sent,
// unanswered message's text, returned to the composer that OWNS it. A module
// singleton (like outboxStore / loopCheckStore) so the owning pane's Composer
// reads it directly — no selectedId↔focusedLeafId detour, no re-derivation on
// re-render. Bus-fed by useLive's "message:recalled" handler; consumed exactly
// ONCE by the composer whose worker.id === recall.workerId.
//
// The old path leaked recall through useLive state → an App-level effect keyed on
// selectedId → a shared pendingText singleton consumed by the FOCUSED pane. That
// re-injected on reselect/reconnect (the source was never cleared) and misrouted
// in split view (selectedId ≠ focused leaf). Here consume clears at the source,
// so it fires once and stops.

let current = null; // { token, workerId, content } | null
let seq = 0;
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getRecall() {
  return current;
}

// A fresh recall supersedes any un-consumed prior one. `token` is a distinct
// identity per recall so the owner clears exactly the one it applied (a newer
// recall landing mid-apply is never dropped by a stale consume).
export function setRecall(workerId, content) {
  if (!workerId) return;
  current = { token: `rc-${++seq}`, workerId, content: content ?? "" };
  emit();
}

// Clear iff `token` is still the live recall. The owning composer calls this the
// instant it applies the text, so a re-render, reselect, or SSE reconnect never
// re-injects it.
export function consumeRecall(token) {
  if (current && current.token === token) {
    current = null;
    emit();
  }
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  current = null;
  seq = 0;
  subs.clear();
}
