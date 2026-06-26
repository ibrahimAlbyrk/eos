// step.ts — the only leaf that touches Eos (§3.4). Resolves its prompt from the
// run bindings, spawns ONE worker through the SINGLE concurrency choke point
// (`ctx.concurrency.run`, §3.9), and awaits its terminal outcome. The worker's
// final answer TEXT is the step's output — its explicit report if it sent one,
// else its last message (the adapter settles either way). When the node declares
// an `outputSchema` (a live Zod
// schema in the code-DSL path), the engine EXTRACTS JSON from that text and
// `safeParse`s it; on a parse/validation failure it re-prompts the worker EXACTLY
// once, and worst case falls back to the raw report text with a `failed` status so
// downstream never wedges on a typed binding. The engine's Template Method does
// the journaling; this executor never does.

import type { StepNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor, WorkflowExecCtx } from "../../ports/StepExecutor.ts";
import type { SpawnStepSpec, StepOutcome } from "../../ports/WorkerSpawnPort.ts";
import { execLocals, errMessage, extractJson } from "./util.ts";

export const SCHEMA_INSTRUCTION =
  "\n\nEnd your final answer (your last message) with the result as JSON in a fenced ```json block matching the schema.";

// Appended to EVERY step prompt so the worker's terminal message is reliably
// token-shaped — the IDLE-edge capture grabs that final message as the step
// outcome, and signalStatus only passes a `result:` signal (fail-closed). Without
// this, a non-reporting worker's arbitrary prose classifies as `unknown` and would
// silently fail the step. Composes with SCHEMA_INSTRUCTION when a schema is present
// (a `result:` first line plus a fenced ```json block).
export const STEP_REPORT_INSTRUCTION =
  "\n\nEnd your final message with a first line that is EXACTLY one of `result:` / `needs input:` / " +
  "`failed:` followed by a one-line headline — that first line is how the workflow records this step's outcome.";

// Duck-typed Zod check — the code-DSL path carries a live schema (parseable); a
// serialized declarative spec carries a plain JSON-Schema object (not parseable
// in pure core), in which case validation is skipped and the raw text flows.
interface ZodLike {
  safeParse(_value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
}
function asZod(schema: unknown): ZodLike | null {
  return schema && typeof (schema as ZodLike).safeParse === "function" ? (schema as ZodLike) : null;
}

// Fail-closed: success requires a positive `result:` signal, NOT merely the
// absence of a failure signal. `unknown` (an unrecognized final message) and
// `needs-input`/`failed` all fail the step, so a non-answer surfaces loudly
// instead of passing on prose.
function signalStatus(signal: StepOutcome["signal"]): NodeResult["status"] {
  return signal === "result" ? "passed" : "failed";
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

    // No schema: the report TEXT is the output.
    if (!schema) {
      const outcome = await spawnStep(node, ctx, basePrompt + STEP_REPORT_INSTRUCTION);
      return {
        output: outcome.reportText,
        status: signalStatus(outcome.signal),
        childWorkerIds: [outcome.workerId],
      };
    }

    // Schema: extract + validate JSON from the report text. Re-prompt EXACTLY
    // once on failure; worst case bind the raw text but mark the step failed so a
    // downstream binding never silently consumes prose as a typed object.
    const prompt = basePrompt + SCHEMA_INSTRUCTION + STEP_REPORT_INSTRUCTION;
    const first = await spawnStep(node, ctx, prompt);
    const firstTry = validate(schema, first.reportText);
    if (firstTry.ok) {
      return { output: firstTry.value, status: "passed", childWorkerIds: [first.workerId] };
    }

    const retryPrompt =
      `${prompt}\n\nYour previous answer did not contain valid JSON matching the schema (${firstTry.error}). End your final answer with a corrected ` +
      "```json block.";
    const second = await spawnStep(node, ctx, retryPrompt);
    const secondTry = validate(schema, second.reportText);
    if (secondTry.ok) {
      return { output: secondTry.value, status: "passed", childWorkerIds: [second.workerId] };
    }

    return { output: second.reportText, status: "failed", childWorkerIds: [second.workerId] };
  },
};
