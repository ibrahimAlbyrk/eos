// Flatten every worker's live background processes (Monitor tool / `Bash
// run_in_background`) into one cross-worker list for the corner activity
// widget. Pure — no React, no fetch — so it is trivially testable in isolation
// and the widget depends on this abstraction, not on the worker shape (DIP).

export function selectBackgroundActivity(workers) {
  const out = [];
  for (const w of workers ?? []) {
    for (const e of w.backgroundActivity ?? []) {
      out.push({ ...e, workerId: w.id, workerName: w.name || w.id });
    }
  }
  return out;
}
