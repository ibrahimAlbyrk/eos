// subWorkflow.ts — resolve a stored definition by name and run its root (§3.3 —
// registry lookup + engine.runNode, no Mediator). The sub-workflow runs in an
// ISOLATED binding scope seeded with the node's `args` (so its `{{args.*}}`
// resolve to its own inputs, not the parent's), and its node ids are scoped under
// this call's id so they never collide with the parent journal or with a second
// invocation of the same sub-workflow. Its aggregate output lands in the PARENT
// scope under this node's id (the engine's Template Method binds it on return).
// Sub-workflow experts are NOT spawned in v1 (only the root tree runs).

import type { SubWorkflowNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor, WorkflowExecCtx } from "../../ports/StepExecutor.ts";
import { isWorkflowGraph } from "../../../../contracts/src/workflow-graph.ts";
import { BindingScope } from "../bindings.ts";
import { scopeNodeIds } from "../node-scope.ts";

export const subWorkflowExecutor: StepExecutor<SubWorkflowNode> = {
  type: "subWorkflow",
  async execute(node, ctx): Promise<NodeResult> {
    if (!ctx.resolveDefinition) {
      throw new Error(`subWorkflow "${node.id}" requires a definition resolver`);
    }
    const def = ctx.resolveDefinition(node.name);
    if (!def) throw new Error(`subWorkflow definition "${node.name}" not found`);
    // This v1 tree executor only runs when a v1 tree references a stored definition
    // directly. A v2 graph is reached only via the graph scheduler's `subGraph` kind
    // (which lowers either shape with toGraph), so a graph resolved here is a mis-wire.
    if (isWorkflowGraph(def)) {
      throw new Error(`subWorkflow "${node.id}" resolved a v2 graph "${node.name}"; reference it from a graph subGraph node instead`);
    }

    const childCtx: WorkflowExecCtx = {
      ...ctx,
      bindings: new BindingScope(node.args ?? ctx.args),
      item: undefined,
      index: undefined,
    };
    const scoped = scopeNodeIds(def.root, `@${node.id}`);
    return ctx.engine.runNode(scoped, childCtx);
  },
};
