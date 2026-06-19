// RuntimeWorkerDefinitionStore — holds orchestrator-created worker definitions. Keyed by
// OWNER (the creating orchestrator's id) so one orchestrator's runtime definitions
// never leak to another's workers (the per-owner scope guard). Session-only:
// a daemon restart drops the store; already-spawned children keep their baked
// behavior (worker_definition name, materialized tool_scope, and the model/effort/
// permission already on their row). The orchestrator re-creates to spawn new ones.

import type { WorkerDefinition, WorkerDefinitionRecord } from "../../contracts/src/worker-definition.ts";

export class RuntimeWorkerDefinitionStore {
  private byOwner = new Map<string, Map<string, WorkerDefinition>>();

  create(ownerId: string, t: WorkerDefinition): void {
    let m = this.byOwner.get(ownerId);
    if (!m) {
      m = new Map();
      this.byOwner.set(ownerId, m);
    }
    m.set(t.name, t);
  }

  listFor(ownerId: string): WorkerDefinitionRecord[] {
    const m = this.byOwner.get(ownerId);
    if (!m) return [];
    return [...m.values()].map((t) => ({ ...t, source: "runtime" as const }));
  }
}
