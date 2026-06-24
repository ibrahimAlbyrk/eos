// phase.ts — observability grouping (§3.3). Emits a step-change carrying the human
// phase label (running, then the body's terminal status) so the progress stream
// shows the grouping, then runs the wrapped body and passes its result through.

import type { PhaseNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor } from "../../ports/StepExecutor.ts";

export const phaseExecutor: StepExecutor<PhaseNode> = {
  type: "phase",
  async execute(node, ctx): Promise<NodeResult> {
    ctx.progress.stepChanged(ctx.runId, node.label, "running");
    const result = await ctx.engine.runNode(node.body, ctx);
    ctx.progress.stepChanged(ctx.runId, node.label, result.status === "failed" ? "failed" : "passed");
    return result;
  },
};
