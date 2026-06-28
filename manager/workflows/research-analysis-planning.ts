// research-analysis-planning — the canonical "3 research → 5 analysis → 2 planning"
// barrier topology (report §5.2), shipped as a builtin. Each phase is a true barrier:
// every analysis pass synthesizes the FULL research corpus (`{{nodes.research-*.output}}`
// glob), and every plan synthesizes ALL analyses. Static fan-out (3 / 5 / 2) uses host
// `Array.from` in the Builder — data-dependent counts would use a `forEach` node.
//
// The `from` specialists (researcher / analyst / planner) name the intended roles;
// a deployment supplies them as worker-definitions (absent ⇒ the default worker).
// Output schemas light up the typed bindings: each step ends its final report
// with a matching ```json block, extracted + validated engine-side (§3.6).
//
// SHIPPED AS A v2 GRAPH: the authored v1 tree below is the generation SOURCE — it is
// compiled with `treeToGraph` (the exact compile the engine runs for any v1 tree on
// load, so execution is unchanged) and given an explicit left-to-right layout so the
// graph editor can open it read-only.

import { z } from "zod";
import { wf } from "../../core/src/workflow/dsl.ts";
import { treeToGraph } from "../../core/src/workflow/tree-to-graph.ts";
import { collapseRedundantMerges } from "../../core/src/workflow/collapse-redundant-merges.ts";
import type { WorkflowGraph } from "../../contracts/src/workflow-graph.ts";
import { layoutGraph } from "./layout.ts";

const ResearchSchema = z.object({ angle: z.number().int().optional(), summary: z.string() });
const AnalysisSchema = z.object({ pass: z.number().int().optional(), analysis: z.string() });
const PlanSchema = z.object({ plan: z.string() });

const tree = wf.define("research-analysis-planning", (b) => ({
  description: "Three research angles → five analysis passes over the full corpus → two synthesized plans.",
  experts: [],
  root: b.sequence([
    b.phase(
      "research",
      b.parallel(
        Array.from({ length: 3 }, (_, i) =>
          b.step({
            id: `research-${i}`,
            from: "researcher",
            prompt: `Research angle ${i} of: {{args.topic}}`,
            outputSchema: ResearchSchema,
          }),
        ),
      ),
    ),
    b.phase(
      "analysis",
      b.parallel(
        Array.from({ length: 5 }, (_, i) =>
          b.step({
            id: `analysis-${i}`,
            from: "analyst",
            prompt: `Analysis pass ${i} over the full research corpus: {{nodes.research-*.output}}`,
            outputSchema: AnalysisSchema,
          }),
        ),
      ),
    ),
    b.phase(
      "planning",
      b.parallel(
        Array.from({ length: 2 }, (_, i) =>
          b.step({
            id: `plan-${i}`,
            from: "planner",
            prompt: `Produce plan ${i} from all analyses: {{nodes.analysis-*.output}}`,
            outputSchema: PlanSchema,
          }),
        ),
      ),
    ),
  ]),
}));

export const researchAnalysisPlanning: WorkflowGraph = layoutGraph(collapseRedundantMerges(treeToGraph(tree)));
