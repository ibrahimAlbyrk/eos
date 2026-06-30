import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makePolicyToolGate } from "../PolicyToolGate.ts";
import type { PolicyDecider } from "../sdk/SdkPermissionBridge.ts";
import { runTurn } from "../../../core/src/use-cases/ToolRuntime.ts";
import type { ModelClient } from "../../../core/src/ports/ModelClient.ts";

describe("PolicyToolGate — Lane B gate over the shared policy engine", () => {
  it("allows when the policy allows", async () => {
    const policy: PolicyDecider = { async decide() { return { behavior: "allow" }; } };
    const gate = makePolicyToolGate("w-1", policy);
    assert.deepEqual(await gate.decide("Read", { file_path: "/x" }), { allow: true, updatedInput: undefined });
  });

  it("denies with the policy message when denied", async () => {
    const policy: PolicyDecider = { async decide() { return { behavior: "deny", message: "nope" }; } };
    const gate = makePolicyToolGate("w-1", policy);
    assert.deepEqual(await gate.decide("Bash", { command: "rm -rf /" }), { allow: false, message: "nope" });
  });

  it("hard-denies a blocked builtin (AskUserQuestion) without consulting policy", async () => {
    let consulted = false;
    const policy: PolicyDecider = { async decide() { consulted = true; return { behavior: "allow" }; } };
    const gate = makePolicyToolGate("w-1", policy);
    const r = await gate.decide("AskUserQuestion", {});
    assert.equal(r.allow, false);
    assert.equal(consulted, false);
  });

  it("hard-denies the blocked builtin Workflow with a Workflow-specific message", async () => {
    let consulted = false;
    const policy: PolicyDecider = { async decide() { consulted = true; return { behavior: "allow" }; } };
    const gate = makePolicyToolGate("w-1", policy);
    const r = await gate.decide("Workflow", {});
    assert.equal(r.allow, false);
    assert.equal(consulted, false);
    assert.match(r.message ?? "", /mcp__orchestrator__workflow/);
  });

  it("passes the workerId + tool through to the policy", async () => {
    const seen: unknown[] = [];
    const policy: PolicyDecider = { async decide(i) { seen.push(i); return { behavior: "allow" }; } };
    await makePolicyToolGate("w-9", policy).decide("Edit", { file_path: "/y" });
    assert.deepEqual(seen, [{ workerId: "w-9", toolName: "Edit", input: { file_path: "/y" } }]);
  });

  it("propagates a policy rewrite (updatedInput) on allow", async () => {
    const policy: PolicyDecider = {
      async decide() { return { behavior: "allow", updatedInput: { command: "ls -la" } }; },
    };
    const gate = makePolicyToolGate("w-1", policy);
    assert.deepEqual(await gate.decide("Bash", { command: "ls" }), { allow: true, updatedInput: { command: "ls -la" } });
  });

  it("the rewritten input is what reaches the tool's execute via ToolRuntime", async () => {
    const policy: PolicyDecider = {
      async decide() { return { behavior: "allow", updatedInput: { command: "echo rewritten" } }; },
    };
    const gate = makePolicyToolGate("w-1", policy);
    let executedWith: Record<string, unknown> | undefined;
    const tools = new Map([["Bash", { name: "Bash", async execute(i: Record<string, unknown>) { executedWith = i; return "ok"; } }]]);
    let calls = 0;
    const model: ModelClient = {
      // First round-trip issues the tool call (with the ORIGINAL input); second ends the turn.
      async createTurn() {
        return calls++ === 0
          ? { toolCalls: [{ callId: "c1", name: "Bash", input: { command: "echo original" } }], stopReason: "tool_use" }
          : { toolCalls: [], stopReason: "end_turn" };
      },
    };
    await runTurn({ model, tools, gate, emit() {} }, [{ role: "user", content: "go" }]);
    assert.deepEqual(executedWith, { command: "echo rewritten" });
  });
});
