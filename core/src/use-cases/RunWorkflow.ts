// RunWorkflow — start a workflow run: resolve the definition (an inline `spec`, or
// a stored `from` name via the overlay resolver), then drive the engine's run()
// Template Method (which mints the anchor, inserts the run, spawns experts, walks
// the tree, persists, and tears down). Thin glue (clone of the loop use-cases);
// the runId is minted by the caller (the manager command layer) and threaded in,
// mirroring how spawn ids are minted at the command chokepoint.

import { NotFoundError } from "../errors/index.ts";
import type { WorkflowEngine, WorkflowRunResult } from "../ports/WorkflowEngine.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";

export interface RunWorkflowDeps {
  engine: WorkflowEngine;
  // Overlay resolver for a stored `from` name (builtin → user/project → runtime),
  // supplied by the manager; absent ⇒ only inline `spec` runs.
  resolveDefinition?: (_name: string, _ownerId: string) => WorkflowDefinition | null;
}

export interface RunWorkflowInput {
  runId: string;
  ownerId: string;
  mode: string;
  signal?: AbortSignal;
  from?: string;
  spec?: WorkflowDefinition;
  args?: unknown;
}

export async function runWorkflow(deps: RunWorkflowDeps, input: RunWorkflowInput): Promise<WorkflowRunResult> {
  const def = input.spec
    ?? (input.from && deps.resolveDefinition ? deps.resolveDefinition(input.from, input.ownerId) : null);
  if (!def) throw new NotFoundError("workflow definition", input.from ?? "(inline)");

  return deps.engine.run(def, input.args, {
    runId: input.runId,
    ownerId: input.ownerId,
    mode: input.mode,
    signal: input.signal,
  });
}
