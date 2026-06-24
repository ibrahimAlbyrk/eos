// pipeline.ts — ⚠️ the correctness landmine (§3.2). A pipeline runs N INDEPENDENT
// per-item chains CONCURRENTLY: each item flows through ALL its stages on its own,
// so item A can be in stage 3 while item B is still in stage 1. It is NOT
// `for stage: parallel(items.map(stage))` — that barrier-between-stages collapses
// the pipeline into sequence-of-parallel-stages and destroys the whole point.
// Wall-clock = slowest single item-chain (the leaf gate still bounds true
// concurrency). Each item's stages are scoped under a per-item suffix so their
// journal rows / bindings never collide, and a stage's `{{nodes.<priorStage>…}}`
// ref resolves to THAT item's prior-stage output (cross-stage refs rewritten by
// scoping the chain as one subtree). The first stage reads the item via `{{item}}`.

import type { PipelineNode, SequenceNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor, WorkflowExecCtx } from "../../ports/StepExecutor.ts";
import { scopeNodeIds } from "../node-scope.ts";
import { resolveList, errMessage } from "./util.ts";

export const pipelineExecutor: StepExecutor<PipelineNode> = {
  type: "pipeline",
  async execute(node, ctx): Promise<NodeResult> {
    const items = resolveList(ctx, node.over);

    // Each item-chain is an INDEPENDENT promise launched up-front; Promise.all
    // only barriers at the very end to aggregate. No barrier BETWEEN stages.
    const chains = items.map((item, i) => runItemChain(node, item, i, ctx));
    const results = await Promise.all(chains);

    const childWorkerIds = results.flatMap((r) => r.childWorkerIds ?? []);
    const status: NodeResult["status"] = results.some((r) => r.status === "failed") ? "failed" : "passed";
    return {
      output: results.map((r) => r.output),
      status,
      childWorkerIds: childWorkerIds.length ? childWorkerIds : undefined,
    };
  },
};

function runItemChain(node: PipelineNode, item: unknown, i: number, ctx: WorkflowExecCtx): Promise<NodeResult> {
  // Run the stages as one in-order sequence so cross-stage refs are rewritten
  // together; scoping the whole chain keeps each item's rows/bindings distinct.
  const chain: SequenceNode = { type: "sequence", id: `${node.id}::chain`, children: node.stages };
  const scoped = scopeNodeIds(chain, `#${i}`);
  const itemCtx: WorkflowExecCtx = { ...ctx, item, index: i };
  return ctx.engine.runNode(scoped, itemCtx).catch((e): NodeResult => ({
    output: { error: errMessage(e) },
    status: "failed",
  }));
}
