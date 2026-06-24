// WorkflowDefinitionSource — where catalogued workflow definitions come from. The
// adapter (FileWorkflowDefinitionSource) reads ~/.eos/workflows/* and emits each
// tagged with its provenance; core stays oblivious to storage and on-disk format.
// Clone of WorkerDefinitionSource. Later-listed dirs override earlier by name.

import type { WorkflowDefinitionRecord } from "../../../contracts/src/workflow.ts";

export interface WorkflowDefinitionSource {
  list(): WorkflowDefinitionRecord[];
}
