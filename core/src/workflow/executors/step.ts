// step.ts — the only leaf that touches Eos (§3.4). Resolves its prompt from the
// run bindings, spawns ONE worker through the SINGLE concurrency choke point
// (`ctx.concurrency.run`, §3.9), and awaits its terminal report. When the node
// declares an `outputSchema` (a live Zod schema in the code-DSL path), the typed
// result is `safeParse`d; a failure re-prompts the worker with the validation
// error appended, up to a bounded number of retries (Claude Code's schema
// behavior). With no schema the status-prefixed report text is the output. The
// engine's Template Method does the journaling; this executor never does.

import type { StepNode } from "../../../../contracts/src/workflow-node.ts";
import type { NodeResult, StepExecutor } from "../../ports/StepExecutor.ts";
import type { SpawnStepSpec, StepOutcome } from "../../ports/WorkerSpawnPort.ts";
import { execLocals, errMessage } from "./util.ts";

const MAX_VALIDATION_RETRIES = 2; // initial attempt + 2 re-prompts
const SCHEMA_INSTRUCTION =
  "\n\nReturn your result as JSON via the submit_step_output tool, matching the required output schema.";

// Duck-typed Zod check — the code-DSL path carries a live schema (parseable); a
// serialized declarative spec carries a plain JSON-Schema object (not parseable
// in pure core), in which case validation is skipped and the raw output flows.
interface ZodLike {
  safeParse(_value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
}
function asZod(schema: unknown): ZodLike | null {
  return schema && typeof (schema as ZodLike).safeParse === "function" ? (schema as ZodLike) : null;
}

function signalStatus(signal: StepOutcome["signal"]): NodeResult["status"] {
  return signal === "failed" || signal === "needs-input" ? "failed" : "passed";
}

export const stepExecutor: StepExecutor<StepNode> = {
  type: "step",
  async execute(node, ctx): Promise<NodeResult> {
    const schema = asZod(node.outputSchema);
    const basePrompt = ctx.bindings.resolve(node.prompt, execLocals(ctx));
    const schemaSuffix = node.outputSchema ? SCHEMA_INSTRUCTION : "";

    let prompt = basePrompt + schemaSuffix;
    let lastWorkerId: string | undefined;
    let lastError = "";

    const attempts = schema ? MAX_VALIDATION_RETRIES + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const spec: SpawnStepSpec = {
        runId: ctx.runId,
        nodeId: node.id,
        parentId: ctx.anchorId,
        from: node.from,
        prompt,
        model: node.model,
        effort: node.effort,
        toolsAllow: node.toolsAllow,
        toolsDeny: node.toolsDeny,
        mode: ctx.mode,
        collaborate: true,
        outputSchema: node.outputSchema,
      };
      const outcome = await ctx.concurrency.run(() => ctx.spawn.spawnAndAwait(spec, ctx.signal));
      lastWorkerId = outcome.workerId;

      if (!schema) {
        return {
          output: outcome.output ?? outcome.reportText,
          status: signalStatus(outcome.signal),
          childWorkerIds: [outcome.workerId],
        };
      }

      const parsed = schema.safeParse(outcome.output);
      if (parsed.success) {
        return { output: parsed.data, status: "passed", childWorkerIds: [outcome.workerId] };
      }
      lastError = errMessage(parsed.error);
      prompt = `${basePrompt}${schemaSuffix}\n\nYour previous output failed schema validation: ${lastError}. Return corrected JSON via submit_step_output.`;
    }

    return {
      output: { error: "step output failed schema validation", detail: lastError },
      status: "failed",
      childWorkerIds: lastWorkerId ? [lastWorkerId] : undefined,
    };
  },
};
