// WorkflowDefinitionSource — where catalogued workflow definitions come from. The
// adapter (FileWorkflowDefinitionSource) reads ~/.eos/workflows/* and emits each
// tagged with its provenance; core stays oblivious to storage and on-disk format.
// Clone of WorkerDefinitionSource. Later-listed dirs override earlier by name.

import type { AnyWorkflowDefinitionRecord } from "../../../contracts/src/workflow-graph.ts";

export interface WorkflowDefinitionSource {
  // A source may emit v1 trees AND v2 graphs (each tagged with provenance).
  list(): AnyWorkflowDefinitionRecord[];
}
