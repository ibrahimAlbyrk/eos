import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCanUseTool, type PolicyDecider } from "../SdkPermissionBridge.ts";

function allowAll(): PolicyDecider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    decide: async (i) => { calls.push(i.toolName); return { behavior: "allow" }; },
  };
}

const opts = (agentID?: string) => ({ signal: new AbortController().signal, toolUseID: "toolu_1", requestId: "r1", ...(agentID ? { agentID } : {}) }) as never;

describe("makeCanUseTool", () => {
  it("denies present / present_app to a Task subagent — its view would never reach the transcript", async () => {
    const policy = allowAll();
    const canUse = makeCanUseTool("w-1", policy, { askUser: async () => null });
    for (const name of ["mcp__worker__present", "mcp__worker__present_app", "mcp__orchestrator__present"]) {
      const r = await canUse(name, { title: "x" }, opts("agent-7"));
      assert.equal(r.behavior, "deny", name);
      assert.match(String((r as { message?: string }).message), /main-agent only/);
    }
    assert.deepEqual(policy.calls, []);
  });

  it("lets the main loop present, and a subagent use other tools", async () => {
    const policy = allowAll();
    const canUse = makeCanUseTool("w-1", policy, { askUser: async () => null });
    assert.equal((await canUse("mcp__worker__present", { title: "x" }, opts())).behavior, "allow");
    assert.equal((await canUse("mcp__worker__find_places", {}, opts("agent-7"))).behavior, "allow");
    assert.equal((await canUse("mcp__slides__present", {}, opts("agent-7"))).behavior, "allow");
    assert.deepEqual(policy.calls, ["mcp__worker__present", "mcp__worker__find_places", "mcp__slides__present"]);
  });
});
