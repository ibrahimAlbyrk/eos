// register-builtins.ts — the pure factory the composition root calls to populate a
// StepExecutorRegistry with every built-in node executor and a TransformFnRegistry
// with the built-in glue fns (§5.1 — the Open/Closed seam). Adding a node type or
// a glue fn is new code plus one register line here; the composition root may pass
// a pre-seeded TransformFnRegistry to add custom fns, or register more on the
// returned one. This wires NOTHING to the manager container — it is pure.

import type { StepExecutorRegistry } from "../ports/StepExecutorRegistry.ts";
import type { ScriptRunner } from "../ports/ScriptRunner.ts";
import { TransformFnRegistry, defaultTransformFnRegistry } from "./transforms.ts";
import {
  stepExecutor, makeScriptExecutor,
  sequenceExecutor, parallelExecutor, pipelineExecutor,
  forEachExecutor, loopUntilExecutor, conditionalExecutor, phaseExecutor,
  subWorkflowExecutor,
  makeTransformExecutor, makeMapExecutor, makeFilterExecutor,
  makeDedupExecutor, makeTallyExecutor, makeAccumulateExecutor,
} from "./executors/index.ts";

// Default when the composition root wires no real runner (tests / a daemon with
// no scripts dir): a `script` node fails cleanly rather than executing anything.
const unconfiguredScriptRunner: ScriptRunner = {
  async run() {
    return { stdout: "", exitCode: 1, stderr: "script runner not configured" };
  },
};

export function registerBuiltinExecutors(
  registry: StepExecutorRegistry,
  transforms: TransformFnRegistry = defaultTransformFnRegistry(),
  runner: ScriptRunner = unconfiguredScriptRunner,
): { transforms: TransformFnRegistry } {
  registry.register(stepExecutor);
  registry.register(makeScriptExecutor(runner));
  registry.register(sequenceExecutor);
  registry.register(parallelExecutor);
  registry.register(pipelineExecutor);
  registry.register(forEachExecutor);
  registry.register(loopUntilExecutor);
  registry.register(conditionalExecutor);
  registry.register(phaseExecutor);
  registry.register(subWorkflowExecutor);
  registry.register(makeTransformExecutor(transforms));
  registry.register(makeMapExecutor(transforms));
  registry.register(makeFilterExecutor(transforms));
  registry.register(makeDedupExecutor(transforms));
  registry.register(makeTallyExecutor(transforms));
  registry.register(makeAccumulateExecutor(transforms));
  return { transforms };
}
