// Pure, deterministic, Clock-free available-workers catalog merge — the single
// owner of catalog precedence + dedup, the LIST counterpart to the find-one
// resolveWorkerDefinitionByName in worker-definition-resolution.ts.
//
// Precedence: builtin < user < project < runtime — last-by-name wins. Disk
// records arrive already deduped across builtin/user/project (project shadows
// user shadows built-in); runtime (orchestrator-created) definitions overlay
// them by name. Insertion order is stable: a name first seen on disk keeps its
// disk position even when a runtime definition overrides its value, and a
// runtime-only definition appends. This mirrors the name-keyed Map merge the
// /worker-definitions route used inline, so list_available_workers and the
// orchestrator prompt catalog stay byte-identical for the same inputs.

import type { WorkerDefinitionRecord } from "../../../contracts/src/worker-definition.ts";

export function mergeAvailableWorkers(
  disk: WorkerDefinitionRecord[],
  runtime: WorkerDefinitionRecord[],
): WorkerDefinitionRecord[] {
  const byName = new Map<string, WorkerDefinitionRecord>();
  for (const rec of disk) byName.set(rec.name, rec);
  for (const rec of runtime) byName.set(rec.name, rec);
  return [...byName.values()];
}
