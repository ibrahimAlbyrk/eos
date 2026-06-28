// Builtin workflow definitions — the modules that ship with Eos, and the source
// that lists them. This is the FIRST (lowest-precedence) layer of the definition
// overlay (builtin → user/project files → runtime store), so a user or project file
// of the same name shadows a builtin, mirroring the worker-definition resolver. The
// defs are trusted, type-checked code, so the source tags each with `source: "builtin"`
// without re-validating.
//
// The builtins ship as v2 GRAPHS (generated from their authored trees via treeToGraph,
// then laid out) so they open read-only in the graph editor; the resolver/engine run
// a graph directly (toGraph is a no-op for a v2 graph).

import type { WorkflowDefinitionSource } from "../../core/src/ports/WorkflowDefinitionSource.ts";
import type { AnyWorkflowDefinition, AnyWorkflowDefinitionRecord } from "../../contracts/src/workflow-graph.ts";
import { researchAnalysisPlanning } from "./research-analysis-planning.ts";
import { buildWithExperts } from "./build-with-experts.ts";

export const BUILTIN_WORKFLOW_DEFINITIONS: readonly AnyWorkflowDefinition[] = [
  researchAnalysisPlanning,
  buildWithExperts,
];

export class BuiltinWorkflowDefinitionSource implements WorkflowDefinitionSource {
  list(): AnyWorkflowDefinitionRecord[] {
    return BUILTIN_WORKFLOW_DEFINITIONS.map((def) => ({ ...def, source: "builtin" as const }));
  }
}
