// loopUntil.ts — re-run `body` until the `until` predicate holds or `maxIterations`
// is reached (the workflow-level analog of dynamic_loop; the workflow IS the
// control loop, §3.4). Each iteration's body is scoped under a per-iteration
// suffix so its journal rows / bindings stay isolated, and the loop metadata
// (`iteration` / `lastResult` / `lastCount`) is injected into the child ctx so the
// body can read `{{iteration}}`. After each round the loop exposes its own state
// under its node id so the `until` predicate can express "stop when last round
// empty" (`{{nodes.<id>.lastCount}}` == 0) or inspect the last result. Stops on a
// failed body. A loop with neither `until` nor `maxIterations` is malformed (the
// schema notes the engine guards it) — we fail loud rather than spin forever.

import type { LoopUntilNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor, WorkflowExecCtx } from "../../ports/StepExecutor.ts";
import { scopeNodeIds } from "../node-scope.ts";
import { evaluate } from "../predicate.ts";

export const loopUntilExecutor: StepExecutor<LoopUntilNode> = {
  type: "loopUntil",
  async execute(node, ctx): Promise<NodeResult> {
    if (!node.until && node.maxIterations == null) {
      throw new Error(`loopUntil "${node.id}" requires 'until' or 'maxIterations'`);
    }

    const childWorkerIds: string[] = [];
    let lastResult: unknown = undefined;
    let lastCount: number | undefined = undefined;
    let last: NodeResult = { output: undefined, status: "passed" };
    let iteration = 0;

    while (node.maxIterations == null || iteration < node.maxIterations) {
      const scoped = scopeNodeIds(node.body, `#${iteration}`);
      const childCtx: WorkflowExecCtx = { ...ctx, iteration, lastResult, lastCount };
      last = await ctx.engine.runNode(scoped, childCtx);
      if (last.childWorkerIds) childWorkerIds.push(...last.childWorkerIds);

      lastResult = last.output;
      lastCount = Array.isArray(lastResult) ? lastResult.length : undefined;
      iteration += 1;

      // Expose the loop's running state so the `until` predicate can read it
      // (the engine overwrites this binding with the final output on return).
      ctx.bindings.set(node.id, { iteration, last: lastResult, lastCount });

      if (last.status === "failed") break;
      if (node.until && evaluate(node.until, ctx.bindings)) break;
    }

    return {
      output: lastResult,
      status: last.status,
      childWorkerIds: childWorkerIds.length ? childWorkerIds : undefined,
    };
  },
};
