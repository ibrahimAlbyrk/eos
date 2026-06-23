// RuntimeWorkerDefinitionStore — persistence port for orchestrator-created
// ("runtime") worker definitions. Keyed by OWNER (the creating orchestrator's
// id) so one orchestrator's definitions never leak to another's workers (the
// per-owner scope guard). The adapter (SqliteRuntimeWorkerDefinitionStore in
// infra/persistence/) survives a daemon restart: a resumed orchestrator keeps
// the same worker-row id, so its definitions reappear. core stays oblivious to
// storage and on-disk format.

import type { WorkerDefinition, WorkerDefinitionRecord } from "../../../contracts/src/worker-definition.ts";

export interface RuntimeWorkerDefinitionStore {
  // Per-owner UPSERT keyed by definition name (re-create overwrites).
  create(ownerId: string, def: WorkerDefinition): void;
  // Every runtime definition this owner created, each tagged source:"runtime".
  listFor(ownerId: string): WorkerDefinitionRecord[];
  // Drop an owner's definitions when its worker row is permanently removed,
  // so dead-orchestrator rows don't accumulate (driven off "worker:removed").
  deleteForOwner(ownerId: string): void;
}
