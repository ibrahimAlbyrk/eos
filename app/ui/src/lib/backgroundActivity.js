// Flatten every worker's live background processes (Monitor tool / `Bash
// run_in_background`) into one cross-worker list for the corner activity
// widget. Pure — no React, no fetch — so it is trivially testable in isolation
// and the widget depends on this abstraction, not on the worker shape (DIP).

import { nameOf } from "./agentName.js";

export function selectBackgroundActivity(workers) {
  const out = [];
  for (const w of workers ?? []) {
    for (const e of w.backgroundActivity ?? []) {
      // Carry the raw definition + orchestrator flag so the row can render the
      // "(definition)" suffix through <AgentName> (workerName stays a plain
      // string for the row tooltip).
      out.push({
        ...e,
        workerId: w.id,
        workerName: nameOf(w),
        workerDefinition: w.worker_definition ?? null,
        workerIsOrchestrator: w.is_orchestrator,
      });
    }
  }
  return out;
}
