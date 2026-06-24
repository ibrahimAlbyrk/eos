// Builtin workflow definitions — the code-DSL modules that ship with Eos, and the
// source that lists them. This is the FIRST (lowest-precedence) layer of the
// definition overlay (builtin → user/project files → runtime store), so a user or
// project file of the same name shadows a builtin, mirroring the worker-definition
// resolver. The defs are trusted, type-checked code built through `wf.define`, so
// the source tags each with `source: "builtin"` without re-validating.

import type { WorkflowDefinitionSource } from "../../core/src/ports/WorkflowDefinitionSource.ts";
import type { WorkflowDefinition, WorkflowDefinitionRecord } from "../../contracts/src/workflow.ts";
import { researchAnalysisPlanning } from "./research-analysis-planning.ts";
import { buildWithExperts } from "./build-with-experts.ts";

export const BUILTIN_WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] = [
  researchAnalysisPlanning,
  buildWithExperts,
];

export class BuiltinWorkflowDefinitionSource implements WorkflowDefinitionSource {
  list(): WorkflowDefinitionRecord[] {
    return BUILTIN_WORKFLOW_DEFINITIONS.map((def) => ({ ...def, source: "builtin" }));
  }
}
