// step.ts — the only leaf that touches Eos (§3.4). Resolves its prompt from the
// run bindings, spawns ONE workflow-worker node through the SINGLE concurrency
// choke point (`ctx.concurrency.run`, §3.9), and awaits its terminal outcome. The
// node's output is the TYPED value it emits via the workflow_step_output tool (the
// SOLE settle channel — Part B), never scraped from prose. `done` binds that value;
// `failed`/`needs-input` fail the node with the worker's reason. When the node
// declares an `outputSchema` (a live Zod schema in the code-DSL path, or a compiled
// JSON-Schema validator attached manager-side), the engine `safeParse`s the tool
// ARGUMENT directly; on a validation failure it re-prompts the worker EXACTLY once,
// and worst case fails the node so downstream never wedges on a typed binding. The
// engine's Template Method does the journaling; this executor never does.

import type { StepNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor, WorkflowExecCtx } from "../../ports/StepExecutor.ts";
import type { SpawnStepSpec, StepOutcome } from "../../ports/WorkerSpawnPort.ts";
import { execLocals, errMessage } from "./util.ts";

// Duck-typed Zod check — the code-DSL path carries a live schema (parseable); a
// serialized declarative spec carries a plain JSON-Schema object compiled into the
// same safeParse shape manager-side (json-schema-validator). Absent ⇒ no schema.
interface ZodLike {
  safeParse(_value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
}
function asZod(schema: unknown): ZodLike | null {
  return schema && typeof (schema as ZodLike).safeParse === "function" ? (schema as ZodLike) : null;
}

function spawnStep(node: StepNode, ctx: WorkflowExecCtx, prompt: string): Promise<StepOutcome> {
  const spec: SpawnStepSpec = {
    runId: ctx.runId,
    nodeId: node.id,
    parentId: ctx.anchorId,
    definitionOwnerId: ctx.ownerId,
    from: node.from,
    role: "workflow-worker",
    prompt,
    model: node.model,
    effort: node.effort,
    toolsAllow: node.toolsAllow,
    toolsDeny: node.toolsDeny,
    mode: ctx.mode,
    collaborate: false,
    outputSchema: node.outputSchema,
    inputs: ctx.inputs, // typed input-port values delivered on the node's edges (A5)
    loop: node.loop,
  };
  return ctx.concurrency.run(() => ctx.spawn.spawnAndAwait(spec, ctx.signal));
}

// A non-`done` status fails the node with the worker's reason (fail-closed: a
// blocked/failed node surfaces loudly, never silently passes a non-answer).
function failedResult(outcome: StepOutcome): NodeResult {
  return { output: outcome.reason ?? outcome.output, status: "failed", childWorkerIds: [outcome.workerId] };
}

export const stepExecutor: StepExecutor<StepNode> = {
  type: "step",
  async execute(node, ctx): Promise<NodeResult> {
    const schema = asZod(node.outputSchema);
    const resolved = ctx.bindings.resolveStrict(node.prompt, execLocals(ctx));

    // Loud unresolved bindings: a `{{nodes.*}}` ref to a prior step's output that
    // resolved to undefined (wrong path / missing field / unrun node) is a hard
    // authoring error — fail the step naming the binding instead of spawning a
    // worker on empty input.
    if (resolved.unresolved.length > 0) {
      const named = resolved.unresolved.map((p) => `{{${p}}}`).join(", ");
      return {
        output: `step "${node.id}" has unresolved binding(s) ${named} — the referenced node output is missing (wrong path, missing field, or the node did not run)`,
        status: "failed",
      };
    }
    const basePrompt = resolved.text;

    const first = await spawnStep(node, ctx, basePrompt);
    if (first.status !== "done") return failedResult(first);

    // No schema: the emitted output IS the node result.
    if (!schema) {
      return { output: first.output, status: "passed", childWorkerIds: [first.workerId] };
    }

    // Schema: validate the typed tool ARGUMENT directly — no prose scrape. Re-prompt
    // EXACTLY once on a validation failure; worst case fail the node so a downstream
    // binding never silently consumes a mis-shaped object.
    const firstTry = schema.safeParse(first.output);
    if (firstTry.success) {
      return { output: firstTry.data, status: "passed", childWorkerIds: [first.workerId] };
    }

    const retryPrompt =
      `${basePrompt}\n\nYour previous output did not match the required schema (${errMessage(firstTry.error)}). ` +
      "Call workflow_step_output again with output that matches the schema.";
    const second = await spawnStep(node, ctx, retryPrompt);
    if (second.status !== "done") return failedResult(second);
    const secondTry = schema.safeParse(second.output);
    return secondTry.success
      ? { output: secondTry.data, status: "passed", childWorkerIds: [second.workerId] }
      : { output: second.output, status: "failed", childWorkerIds: [second.workerId] };
  },
};
