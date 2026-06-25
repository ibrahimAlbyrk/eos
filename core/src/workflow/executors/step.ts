// step.ts — the only leaf that touches Eos (§3.4). Resolves its prompt from the
// run bindings, spawns ONE worker through the SINGLE concurrency choke point
// (`ctx.concurrency.run`, §3.9), and awaits its terminal report. The final report
// TEXT is the step's output. When the node declares an `outputSchema` (a live Zod
// schema in the code-DSL path), the engine EXTRACTS JSON from that text and
// `safeParse`s it; on a parse/validation failure it re-prompts the worker EXACTLY
// once, and worst case falls back to the raw report text with a `failed` status so
// downstream never wedges on a typed binding. The engine's Template Method does
// the journaling; this executor never does.

import type { StepNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor, WorkflowExecCtx } from "../../ports/StepExecutor.ts";
import type { SpawnStepSpec, StepOutcome } from "../../ports/WorkerSpawnPort.ts";
import { execLocals, errMessage, extractJson } from "./util.ts";

const SCHEMA_INSTRUCTION =
  "\n\nEnd your final report with the result as JSON in a fenced ```json block matching the schema.";

// Duck-typed Zod check — the code-DSL path carries a live schema (parseable); a
// serialized declarative spec carries a plain JSON-Schema object (not parseable
// in pure core), in which case validation is skipped and the raw text flows.
interface ZodLike {
  safeParse(_value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
}
function asZod(schema: unknown): ZodLike | null {
  return schema && typeof (schema as ZodLike).safeParse === "function" ? (schema as ZodLike) : null;
}

function signalStatus(signal: StepOutcome["signal"]): NodeResult["status"] {
  return signal === "failed" || signal === "needs-input" ? "failed" : "passed";
}

function spawnStep(node: StepNode, ctx: WorkflowExecCtx, prompt: string): Promise<StepOutcome> {
  const spec: SpawnStepSpec = {
    runId: ctx.runId,
    nodeId: node.id,
    parentId: ctx.anchorId,
    definitionOwnerId: ctx.ownerId,
    from: node.from,
    prompt,
    model: node.model,
    effort: node.effort,
    toolsAllow: node.toolsAllow,
    toolsDeny: node.toolsDeny,
    mode: ctx.mode,
    collaborate: true,
    outputSchema: node.outputSchema,
    loop: node.loop,
  };
  return ctx.concurrency.run(() => ctx.spawn.spawnAndAwait(spec, ctx.signal));
}

// Extract + validate JSON out of a step's report text against the live schema.
function validate(
  schema: ZodLike,
  reportText: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const { value, found } = extractJson(reportText);
  if (!found) return { ok: false, error: "no JSON block found in the final report" };
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: errMessage(parsed.error) };
}

export const stepExecutor: StepExecutor<StepNode> = {
  type: "step",
  async execute(node, ctx): Promise<NodeResult> {
    const schema = asZod(node.outputSchema);
    const basePrompt = ctx.bindings.resolve(node.prompt, execLocals(ctx));

    // No schema: the report TEXT is the output.
    if (!schema) {
      const outcome = await spawnStep(node, ctx, basePrompt);
      return {
        output: outcome.reportText,
        status: signalStatus(outcome.signal),
        childWorkerIds: [outcome.workerId],
      };
    }

    // Schema: extract + validate JSON from the report text. Re-prompt EXACTLY
    // once on failure; worst case bind the raw text but mark the step failed so a
    // downstream binding never silently consumes prose as a typed object.
    const prompt = basePrompt + SCHEMA_INSTRUCTION;
    const first = await spawnStep(node, ctx, prompt);
    const firstTry = validate(schema, first.reportText);
    if (firstTry.ok) {
      return { output: firstTry.value, status: "passed", childWorkerIds: [first.workerId] };
    }

    const retryPrompt =
      `${prompt}\n\nYour previous final report did not contain valid JSON matching the schema (${firstTry.error}). End your report with a corrected ` +
      "```json block.";
    const second = await spawnStep(node, ctx, retryPrompt);
    const secondTry = validate(schema, second.reportText);
    if (secondTry.ok) {
      return { output: secondTry.value, status: "passed", childWorkerIds: [second.workerId] };
    }

    return { output: second.reportText, status: "failed", childWorkerIds: [second.workerId] };
  },
};
