import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makePolicyToolGate } from "../PolicyToolGate.ts";
import type { PolicyDecider } from "../sdk/SdkPermissionBridge.ts";

describe("PolicyToolGate — Lane B gate over the shared policy engine", () => {
  it("allows when the policy allows", async () => {
    const policy: PolicyDecider = { async decide() { return { behavior: "allow" }; } };
    const gate = makePolicyToolGate("w-1", policy);
    assert.deepEqual(await gate.decide("Read", { file_path: "/x" }), { allow: true });
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

  it("passes the workerId + tool through to the policy", async () => {
    const seen: unknown[] = [];
    const policy: PolicyDecider = { async decide(i) { seen.push(i); return { behavior: "allow" }; } };
    await makePolicyToolGate("w-9", policy).decide("Edit", { file_path: "/y" });
    assert.deepEqual(seen, [{ workerId: "w-9", toolName: "Edit", input: { file_path: "/y" } }]);
  });
});
