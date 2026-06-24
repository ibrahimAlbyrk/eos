// forEach.ts — data-driven fan-out over a bound list whose length is known only at
// runtime (§3.3 — the reason forEach is a reified node, not host JS). Each item's
// body is scoped under a per-item suffix so reused body ids never collide in the
// journal/bindings (P2's flagged concern), and the item is injected so the body
// reads `{{item}}` / `{{index}}`. A barrier in v1 (await all, aggregate per-item
// outputs into this node's output); the leaf gate (§3.9) bounds true concurrency.

import type { ForEachNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor, WorkflowExecCtx } from "../../ports/StepExecutor.ts";
import { scopeNodeIds } from "../node-scope.ts";
import { resolveList, errMessage } from "./util.ts";

export const forEachExecutor: StepExecutor<ForEachNode> = {
  type: "forEach",
  async execute(node, ctx): Promise<NodeResult> {
    const items = resolveList(ctx, node.over);

    const results = await Promise.all(items.map((item, i) => {
      const scoped = scopeNodeIds(node.body, `#${i}`);
      const itemCtx: WorkflowExecCtx = { ...ctx, item, index: i };
      return ctx.engine.runNode(scoped, itemCtx).catch((e): NodeResult => ({
        output: { error: errMessage(e) },
        status: "failed",
      }));
    }));

    const childWorkerIds = results.flatMap((r) => r.childWorkerIds ?? []);
    const status: NodeResult["status"] = results.some((r) => r.status === "failed") ? "failed" : "passed";
    return {
      output: results.map((r) => r.output),
      status,
      childWorkerIds: childWorkerIds.length ? childWorkerIds : undefined,
    };
  },
};
