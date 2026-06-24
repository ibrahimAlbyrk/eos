// sequence.ts — children in order, bindings accumulating between them (§3.3). Each
// child runs through `ctx.engine.runNode`, which writes its output into the run
// bindings before the next child resolves its prompt, so a downstream child sees
// an upstream child's `{{nodes.<id>.output}}`. Short-circuits on a failed child —
// later children depend on earlier ones. The output is the last child's output.

import type { SequenceNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor } from "../../ports/StepExecutor.ts";

export const sequenceExecutor: StepExecutor<SequenceNode> = {
  type: "sequence",
  async execute(node, ctx): Promise<NodeResult> {
    const childWorkerIds: string[] = [];
    let last: NodeResult = { output: undefined, status: "passed" };
    for (const child of node.children) {
      last = await ctx.engine.runNode(child, ctx);
      if (last.childWorkerIds) childWorkerIds.push(...last.childWorkerIds);
      if (last.status === "failed") {
        return { output: last.output, status: "failed", childWorkerIds };
      }
    }
    return { output: last.output, status: last.status, childWorkerIds };
  },
};
