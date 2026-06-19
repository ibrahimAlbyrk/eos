// RuntimeWorkerTypeStore — holds orchestrator-minted worker types. Keyed by
// OWNER (the minting orchestrator's id) so one orchestrator's runtime types
// never leak to another's workers (the per-owner scope guard). Session-only:
// a daemon restart drops the store; already-spawned children keep their baked
// behavior (worker_type name, materialized tool_scope, and the model/effort/
// permission already on their row). The orchestrator re-mints to spawn new ones.

import type { WorkerType, WorkerTypeRecord } from "../../contracts/src/worker-type.ts";

export class RuntimeWorkerTypeStore {
  private byOwner = new Map<string, Map<string, WorkerType>>();

  mint(ownerId: string, t: WorkerType): void {
    let m = this.byOwner.get(ownerId);
    if (!m) {
      m = new Map();
      this.byOwner.set(ownerId, m);
    }
    m.set(t.name, t);
  }

  listFor(ownerId: string): WorkerTypeRecord[] {
    const m = this.byOwner.get(ownerId);
    if (!m) return [];
    return [...m.values()].map((t) => ({ ...t, source: "runtime" as const }));
  }
}
