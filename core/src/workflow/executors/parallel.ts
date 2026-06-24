// parallel.ts — the BARRIER composite (§3.3): all children run concurrently and we
// await ALL. A child that throws is caught and degraded to a `failed` NodeResult
// so one failure never rejects the whole barrier; the node's output aggregates
// every child's output (in order) for a downstream synthesis step. The leaf
// concurrency gate (§3.9) bounds how many actually run at once. Use only when a
// stage needs ALL of the prior stage (synthesis / dedup / early-exit-on-zero).

import type { ParallelNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor, WorkflowExecCtx } from "../../ports/StepExecutor.ts";
import { errMessage } from "./util.ts";

export const parallelExecutor: StepExecutor<ParallelNode> = {
  type: "parallel",
  async execute(node, ctx): Promise<NodeResult> {
    const results = await Promise.all(
      node.children.map((child) => runChild(child, ctx)),
    );
    const childWorkerIds = results.flatMap((r) => r.childWorkerIds ?? []);
    const status: NodeResult["status"] = results.some((r) => r.status === "failed") ? "failed" : "passed";
    return {
      output: results.map((r) => r.output),
      status,
      childWorkerIds: childWorkerIds.length ? childWorkerIds : undefined,
    };
  },
};

function runChild(child: ParallelNode["children"][number], ctx: WorkflowExecCtx): Promise<NodeResult> {
  return ctx.engine.runNode(child, ctx).catch((e): NodeResult => ({
    output: { error: errMessage(e) },
    status: "failed",
  }));
}
