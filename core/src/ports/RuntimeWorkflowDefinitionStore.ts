// RuntimeWorkflowDefinitionStore — persistence port for orchestrator-created
// ("runtime") workflow definitions, keyed by OWNER so one orchestrator's
// definitions never leak to another's runs (clone of RuntimeWorkerDefinitionStore).
// The adapter is SqliteRuntimeWorkflowDefinitionStore in infra/persistence/; it
// survives a daemon restart so a resumed orchestrator's definitions reappear.

import type { WorkflowDefinition, WorkflowDefinitionRecord } from "../../../contracts/src/workflow.ts";

export interface RuntimeWorkflowDefinitionStore {
  create(ownerId: string, def: WorkflowDefinition): void;        // per-owner UPSERT keyed by name
  listFor(ownerId: string): WorkflowDefinitionRecord[];          // each tagged source:"runtime"
  deleteForOwner(ownerId: string): void;                         // drop on "worker:removed"
}
