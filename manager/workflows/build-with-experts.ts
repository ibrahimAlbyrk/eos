// build-with-experts — a build workflow whose implementers consult a STANDING
// expert pool (report §4.5), shipped as a builtin. The two experts are spawned once
// at run start (persistent + collaborate under the run anchor), kept IDLE-but-
// consultable, and torn down with the anchor at run end (§4). A data-driven `forEach`
// fans one implementer per planned module; each implementer is collaborate:true, so
// `ask_peer peerName:"solid-expert"` / "patterns-expert" reaches the standing experts
// and blocks until answered WHILE it implements.
//
// `plan` carries a typed ModulePlanSchema so `{{nodes.plan.output.modules}}`
// resolves to the runtime module list the forEach iterates (without a schema the
// output would be report text, not a list). The `from` roles name the intended
// specialists; a deployment supplies them as worker-definitions.
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

const ModulePlanSchema = z.object({ modules: z.array(z.string()) });
const ImplResultSchema = z.object({ module: z.string(), status: z.string() });
const ReviewSchema = z.object({ verdict: z.string() });

const tree = wf.define("build-with-experts", (b) => ({
  description: "Decompose a feature into modules, implement each with on-demand SOLID/patterns expert consultation, then review.",
  experts: [
    {
      id: "solid-expert",
      from: "solid-expert",
      prompt: "You are the SOLID/clean-code authority for this run. Stay IDLE-but-consultable; answer peers' design questions precisely from SOLID principles.",
    },
    {
      id: "patterns-expert",
      from: "patterns-expert",
      prompt: "You are the design-patterns authority for this run. Stay IDLE-but-consultable; recommend/critique GoF & architectural patterns for peers on demand.",
    },
  ],
  root: b.sequence([
    b.step({
      id: "plan",
      from: "planner",
      prompt: "Break {{args.feature}} into independent modules. Return the module list.",
      outputSchema: ModulePlanSchema,
    }),
    b.phase(
      "implement",
      b.forEach({
        id: "impl",
        over: "{{nodes.plan.output.modules}}",
        body: b.step({
          id: "impl-item",
          from: "implementer",
          prompt: [
            "Implement module: {{item}}.",
            "You may consult peers: ask_peer peerName:'solid-expert' for SRP/OCP/DIP review,",
            "ask_peer peerName:'patterns-expert' for the right pattern. Apply their guidance.",
          ].join(" "),
          outputSchema: ImplResultSchema,
        }),
      }),
    ),
    b.step({
      id: "review",
      from: "reviewer",
      prompt: "Review all modules for SOLID + pattern adherence: {{nodes.impl.output}}",
      outputSchema: ReviewSchema,
    }),
  ]),
}));

export const buildWithExperts: WorkflowGraph = layoutGraph(collapseRedundantMerges(treeToGraph(tree)));
