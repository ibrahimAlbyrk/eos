import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryStepExecutorRegistry } from "../workflow/registry.ts";
import type { StepExecutor, NodeResult, WorkflowExecCtx } from "../ports/StepExecutor.ts";

function fakeExecutor(type: string): StepExecutor {
  return {
    type: type as StepExecutor["type"],
    async execute(_node: unknown, _ctx: WorkflowExecCtx): Promise<NodeResult> {
      return { output: type, status: "passed" };
    },
  } as StepExecutor;
}

describe("InMemoryStepExecutorRegistry", () => {
  it("registers and looks up by node type", () => {
    const reg = new InMemoryStepExecutorRegistry();
    reg.register(fakeExecutor("step"));
    reg.register(fakeExecutor("sequence"));
    assert.equal(reg.has("step"), true);
    assert.equal(reg.has("parallel"), false);
    assert.equal(reg.get("step").type, "step");
    assert.deepEqual(reg.types().sort(), ["sequence", "step"]);
  });

  it("re-register overwrites the prior executor for a type", () => {
    const reg = new InMemoryStepExecutorRegistry();
    const first = fakeExecutor("step");
    const second = fakeExecutor("step");
    reg.register(first);
    reg.register(second);
    assert.equal(reg.get("step"), second);
    assert.equal(reg.types().length, 1);
  });

  it("get throws a clear, enumerated error on an unknown type", () => {
    const reg = new InMemoryStepExecutorRegistry();
    reg.register(fakeExecutor("step"));
    assert.throws(() => reg.get("forEach"), /no step executor for node type "forEach"/);
    assert.throws(() => reg.get("forEach"), /registered: step/);
  });

  it("enumerates 'none' when empty", () => {
    const reg = new InMemoryStepExecutorRegistry();
    assert.throws(() => reg.get("step"), /registered: none/);
  });
});
