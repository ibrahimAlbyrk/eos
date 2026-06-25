import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BindingScope } from "../workflow/bindings.ts";
import { makeScriptExecutor } from "../workflow/executors/script.ts";
import { containsNodeType } from "../workflow/node-scope.ts";
import { buildEngine, spawnPort } from "./helpers/workflowFakes.ts";
import type { ScriptRunner, ScriptRunSpec, ScriptRunResult } from "../ports/ScriptRunner.ts";
import type { ScriptNode, WorkflowNode } from "../../../contracts/src/workflow-node.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";
import type { WorkflowExecCtx } from "../ports/StepExecutor.ts";

function fakeRunner(result: ScriptRunResult): { runner: ScriptRunner; calls: ScriptRunSpec[] } {
  const calls: ScriptRunSpec[] = [];
  return { calls, runner: { async run(spec) { calls.push(spec); return result; } } };
}

// Only `bindings` is exercised by the executor; the rest of the ctx is unused
// here, mirroring the inline-ctx pattern in workflow-executors.test.ts.
function ctxWith(args: unknown, bound: Record<string, unknown> = {}): WorkflowExecCtx {
  const bindings = new BindingScope(args);
  for (const [id, v] of Object.entries(bound)) bindings.set(id, v);
  return { bindings } as unknown as WorkflowExecCtx;
}

describe("script executor (§ITEM 1)", () => {
  it("resolves `over` to JSON input + binding-resolved args, surfaces parsed stdout, passes on exit 0", async () => {
    const { runner, calls } = fakeRunner({ stdout: '{"ok":true}', exitCode: 0, stderr: "" });
    const node: ScriptNode = {
      type: "script", id: "s", script: "do.sh",
      over: "{{nodes.prev.output}}", args: ["{{args.flag}}", "literal"], timeoutMs: 1500,
    };
    const res = await makeScriptExecutor(runner).execute(node, ctxWith({ flag: "F" }, { prev: { a: 1 } }));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].script, "do.sh");
    assert.equal(calls[0].inputJson, '{"a":1}');
    assert.deepEqual(calls[0].args, ["F", "literal"]);
    assert.equal(calls[0].timeoutMs, 1500);
    assert.equal(res.status, "passed");
    assert.deepEqual(res.output, { exitCode: 0, stdout: { ok: true }, stderr: "" });
  });

  it("nonzero exit ⇒ failed; non-JSON stdout flows through as the raw string", async () => {
    const { runner, calls } = fakeRunner({ stdout: "plain text", exitCode: 2, stderr: "boom" });
    const res = await makeScriptExecutor(runner).execute(
      { type: "script", id: "s", script: "x.sh" }, ctxWith({}),
    );
    assert.equal(calls[0].inputJson, "", "no `over` ⇒ empty stdin input");
    assert.equal(res.status, "failed");
    assert.deepEqual(res.output, { exitCode: 2, stdout: "plain text", stderr: "boom" });
  });
});

describe("containsNodeType (trust-gate helper)", () => {
  const scriptInForEach: WorkflowNode = {
    type: "sequence", id: "r",
    children: [
      { type: "step", id: "a", prompt: "p" },
      { type: "forEach", id: "f", over: "{{args.x}}", body: { type: "script", id: "sc", script: "y.sh" } },
    ],
  };

  it("detects a `script` node nested anywhere in the tree", () => {
    assert.equal(containsNodeType(scriptInForEach, "script"), true);
  });

  it("returns false when no `script` node is present", () => {
    const clean: WorkflowNode = { type: "sequence", id: "r", children: [{ type: "step", id: "a", prompt: "p" }] };
    assert.equal(containsNodeType(clean, "script"), false);
  });
});

// node-scope's rewriteNode must suffix the SAME ref fields the executor resolves
// (over + each args string), so a `script` nested in a forEach reads THIS
// iteration's sibling — not a wrong-iteration / unscoped binding. Without the
// `case "script"` rewrite, `{{nodes.sibling.output}}` would resolve to null.
describe("script node scoped inside forEach (per-iteration refs)", () => {
  it("resolves {{nodes.sibling.output}} to that iteration's sibling output", async () => {
    const spawn = spawnPort();   // echoes each step's resolved prompt as its output
    const { engine, deps } = buildEngine(spawn);
    const calls: ScriptRunSpec[] = [];
    deps.registry.register(makeScriptExecutor({
      async run(spec) { calls.push(spec); return { stdout: "ok", exitCode: 0, stderr: "" }; },
    }));

    const def = {
      name: "scoped",
      root: {
        type: "forEach", id: "fe", over: "{{args.items}}",
        body: {
          type: "sequence", id: "body",
          children: [
            { type: "step", id: "sibling", prompt: "sib {{item}}" },
            { type: "script", id: "sc", script: "x.sh", over: "{{nodes.sibling.output}}", args: ["{{nodes.sibling.output}}"] },
          ],
        },
      },
    } as unknown as WorkflowDefinition;

    await engine.run(def, { items: ["x", "y"] }, { runId: "r", ownerId: "o", mode: "default" });

    assert.equal(calls.length, 2, "one script run per iteration");
    assert.deepEqual(calls.map((c) => c.inputJson).sort(), ['"sib x"', '"sib y"'], "each script saw ITS OWN iteration's sibling");
    assert.deepEqual(calls.map((c) => c.args[0]).sort(), ["sib x", "sib y"], "args refs scoped the same way");
  });
});
