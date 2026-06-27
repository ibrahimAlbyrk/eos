// RuntimeWorkflowDefinitionStore — persistence port for orchestrator-created
// ("runtime") workflow definitions, keyed by OWNER so one orchestrator's
// definitions never leak to another's runs (clone of RuntimeWorkerDefinitionStore).
// The adapter is SqliteRuntimeWorkflowDefinitionStore in infra/persistence/; it
// survives a daemon restart so a resumed orchestrator's definitions reappear.

import type {
  AnyWorkflowDefinition, AnyWorkflowDefinitionRecord,
} from "../../../contracts/src/workflow-graph.ts";

export interface RuntimeWorkflowDefinitionStore {
  create(ownerId: string, def: AnyWorkflowDefinition): void;     // per-owner UPSERT keyed by name (v1 tree or v2 graph)
  listFor(ownerId: string): AnyWorkflowDefinitionRecord[];       // each tagged source:"runtime"
  delete(ownerId: string, name: string): boolean;               // drop one stored def; false when no such (owner,name) row
  deleteForOwner(ownerId: string): void;                         // drop on "worker:removed"
}
