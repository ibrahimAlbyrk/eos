// script.ts — the trusted-script leaf (§ITEM 1). Runs a NAMED, allowlisted local
// script (resolved + sandboxed by the injected ScriptRunner, NEVER an arbitrary
// path) with the workflow's data on stdin + EOS_NODE_INPUT, Claude-Code-hook
// style. Deterministic glue, NOT an agent spawn: no concurrency gate, no worker —
// it is cheap local I/O, not subject to the leaf-spawn cap. The script's stdout
// (parsed as JSON when it parses, else the raw string) plus its exitCode/stderr
// become the node output so a downstream `conditional` can branch; exit 0 ⇒
// passed, nonzero ⇒ failed. Reached via factory closure (the makeTransformExecutor
// precedent) so the runner is injected once at composition. Pure: no Node imports
// and no Date.now/Math.random — all process I/O lives behind the port.

import type { ScriptNode } from "../../../../contracts/src/workflow-node.ts";
import type { StepExecutor } from "../../ports/StepExecutor.ts";
import type { ScriptRunner } from "../../ports/ScriptRunner.ts";
import { execLocals } from "./util.ts";

// safeStringify equivalent — core can't import infra's; mirror the in-core
// try/catch idiom (bindings.ts/util.ts). JSON.stringify(undefined) is `undefined`,
// not a string, so coalesce it to a valid JSON literal for the stdin/env input.
function toInputJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  } catch {
    return "null";
  }
}

// Lenient stdout reader: a script that emits JSON yields a structured output a
// downstream node can drill into; anything else flows through as the raw string.
function parseStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return stdout;
  try {
    return JSON.parse(trimmed);
  } catch {
    return stdout;
  }
}

export function makeScriptExecutor(runner: ScriptRunner): StepExecutor<ScriptNode> {
  return {
    type: "script",
    async execute(node, ctx) {
      const locals = execLocals(ctx);
      const inputJson = node.over !== undefined
        ? toInputJson(ctx.bindings.resolveRef(node.over, locals))
        : "";
      const args = (node.args ?? []).map((a) => ctx.bindings.resolve(a, locals));

      const { stdout, exitCode, stderr } = await runner.run({
        script: node.script,
        inputJson,
        args,
        timeoutMs: node.timeoutMs,
      });

      return {
        output: { exitCode, stdout: parseStdout(stdout), stderr },
        status: exitCode === 0 ? "passed" : "failed",
      };
    },
  };
}
