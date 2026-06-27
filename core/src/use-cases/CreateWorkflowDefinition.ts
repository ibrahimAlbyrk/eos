// CreateWorkflowDefinition — validate an orchestrator-emitted spec and persist it
// as a per-owner runtime definition for reuse (mirrors create_worker). Validation
// re-parses through the contracts schema (the single source of truth) so a
// malformed spec fails loud at the use-case boundary. Returns the stored name. No
// bus event: there is no workflow-definition EventBus topic and inventing one is
// out of this phase's scope — the UI refetch nudge is the route layer's job
// (mirroring how create_worker persists at the route).

import { WorkflowDefinitionSchema } from "../../../contracts/src/workflow.ts";
import { WorkflowGraphSchema, isWorkflowGraph } from "../../../contracts/src/workflow-graph.ts";
import { findDuplicateIds } from "../workflow/node-scope.ts";
import { ValidationError } from "../errors/index.ts";
import type { RuntimeWorkflowDefinitionStore } from "../ports/RuntimeWorkflowDefinitionStore.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";
import type { AnyWorkflowDefinition } from "../../../contracts/src/workflow-graph.ts";

export interface CreateWorkflowDefinitionDeps {
  store: RuntimeWorkflowDefinitionStore;
}

export interface CreateWorkflowDefinitionInput {
  ownerId: string;
  spec: AnyWorkflowDefinition;   // v1 tree (orchestrator) or v2 graph (editor SAVE)
}

export function createWorkflowDefinition(
  deps: CreateWorkflowDefinitionDeps,
  input: CreateWorkflowDefinitionInput,
): { name: string } {
  // v2 graph: WorkflowGraphSchema.parse runs the full structural validation
  // (id-uniqueness / dangling+typed+self edges / acyclicity) and applies the
  // edge/port defaults. v1 tree: re-parse the contract + the separate node-id
  // uniqueness check (the tree schema does not enforce it).
  if (isWorkflowGraph(input.spec)) {
    const graph = WorkflowGraphSchema.parse(input.spec);
    deps.store.create(input.ownerId, graph);
    return { name: graph.name };
  }
  const def = WorkflowDefinitionSchema.parse(input.spec);
  assertUniqueNodeIds(def);
  deps.store.create(input.ownerId, def);
  return { name: def.name };
}

// Node ids are run-scoped binding keys; duplicates clobber outputs last-write-wins
// (engine.ts), so reject them at acceptance with the offending id(s) named.
// Shared by run-inline acceptance (WorkflowService.run) and this stored path.
export function assertUniqueNodeIds(def: WorkflowDefinition): void {
  const dupes = findDuplicateIds(def.root);
  if (dupes.length) {
    throw new ValidationError(`workflow definition has duplicate node id(s): ${dupes.join(", ")}`);
  }
}
