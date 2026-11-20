// Asks before a model change that needs the conversation summarized first:
// the conversation does not fit the new model's context, and the server
// changed nothing (PUT /workers/:id/model?summary=ask answers 409 with this
// code). One question at a time — ModelSummaryDialog (mounted once) answers it.

import { useSyncExternalStore } from "react";

export const NEEDS_SUMMARY = "needs-summary";

let pending = null; // { worker, model, resolve }
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function confirmModelSummary(worker, model) {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { worker, model, resolve };
    emit();
  });
}

export function answerModelSummary(ok) {
  const p = pending;
  if (!p) return;
  pending = null;
  emit();
  p.resolve(ok);
}

export function useModelSummaryRequest() {
  return useSyncExternalStore(subscribe, () => pending, () => null);
}
