// CreateWorkflowDefinition — validate an orchestrator-emitted spec and persist it
// as a per-owner runtime definition for reuse (mirrors create_worker). Validation
// re-parses through the contracts schema (the single source of truth) so a
// malformed spec fails loud at the use-case boundary. Returns the stored name. No
// bus event: there is no workflow-definition EventBus topic and inventing one is
// out of this phase's scope — the UI refetch nudge is the route layer's job
// (mirroring how create_worker persists at the route).

import { WorkflowDefinitionSchema } from "../../../contracts/src/workflow.ts";
import type { RuntimeWorkflowDefinitionStore } from "../ports/RuntimeWorkflowDefinitionStore.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";

export interface CreateWorkflowDefinitionDeps {
  store: RuntimeWorkflowDefinitionStore;
}

export interface CreateWorkflowDefinitionInput {
  ownerId: string;
  spec: WorkflowDefinition;
}

export function createWorkflowDefinition(
  deps: CreateWorkflowDefinitionDeps,
  input: CreateWorkflowDefinitionInput,
): { name: string } {
  const def = WorkflowDefinitionSchema.parse(input.spec);
  deps.store.create(input.ownerId, def);
  return { name: def.name };
}
