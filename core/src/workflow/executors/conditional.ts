// conditional.ts — run `then` or `else` by a Specification predicate over the run
// bindings (§3.3). The predicate is pure (`predicate.evaluate`); when it is false
// and there is no `else`, the node is `skipped` with no output. The chosen
// branch's NodeResult flows straight through.

import type { ConditionalNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor } from "../../ports/StepExecutor.ts";
import { evaluate } from "../predicate.ts";

export const conditionalExecutor: StepExecutor<ConditionalNode> = {
  type: "conditional",
  async execute(node, ctx): Promise<NodeResult> {
    const branch = evaluate(node.predicate, ctx.bindings) ? node.then : node.else;
    if (!branch) return { output: undefined, status: "skipped" };
    return ctx.engine.runNode(branch, ctx);
  },
};
