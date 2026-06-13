import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolicyGatewayService, type PolicyGatewayServiceDeps } from "../services/PolicyGatewayService.ts";
import { compileRule, type Policy } from "../domain/policy.ts";
import type { PermissionMode } from "../domain/permission-mode.ts";

interface PolicyEvent { tool: string; decision: string }

function buildService(opts: { mode?: PermissionMode; policy?: Partial<Policy> } = {}) {
  const policy: Policy = { default: "ask", ttlMs: 1000, rules: [], ...opts.policy };
  const policyEvents: PolicyEvent[] = [];
  const deps = {
    pending: { insert() {}, findById: () => null, listUnresolved: () => [], resolve: () => true, sweepExpired: () => 0, deleteByWorker() {} },
    events: {
      append: (_id: string, _ts: number, type: string, payload: unknown) => {
        if (type === "policy") policyEvents.push(payload as PolicyEvent);
        return policyEvents.length;
      },
      patchPayload() {}, list: () => [], deleteByWorker() {},
    },
    bus: { publish() {}, subscribe: () => () => {} },
    clock: { now: () => 1000 },
    ids: { newPendingId: () => "p1" },
    modeResolver: { resolveFor: () => opts.mode ?? "acceptEdits" },
    getPolicy: () => policy,
  } as unknown as PolicyGatewayServiceDeps;
  return { svc: new PolicyGatewayService(deps), policyEvents };
}

const SPAWN = "mcp__orchestrator__spawn_worker";
const REPORT = "mcp__worker__send_message_to_parent";

describe("PolicyGatewayService — subagent caller scope", () => {
  it("denies an Eos control tool called from a subagent", async () => {
    const { svc } = buildService();
    const d = await svc.decide({ workerId: "w1", toolName: SPAWN, input: {}, agentId: "a1" });
    assert.equal(d.behavior, "deny");
    assert.ok("message" in d && typeof d.message === "string" && d.message.includes("main-agent only"));
  });

  it("allows the same tool from the main loop (no agentId)", async () => {
    const { svc } = buildService();
    const d = await svc.decide({ workerId: "w1", toolName: SPAWN, input: {} });
    assert.equal(d.behavior, "allow");
  });

  it("leaves user MCP tools untouched for subagents", async () => {
    const { svc } = buildService();
    const d = await svc.decide({ workerId: "w1", toolName: "mcp__context7__query-docs", input: {}, agentId: "a1" });
    assert.equal(d.behavior, "allow");
  });

  it("wins over bypassPermissions mode", async () => {
    const { svc } = buildService({ mode: "bypassPermissions" });
    const d = await svc.decide({ workerId: "w1", toolName: REPORT, input: {}, agentId: "a1" });
    assert.equal(d.behavior, "deny");
  });

  it("wins over an explicit policy.yaml allow rule", async () => {
    const rule = compileRule({ tool: SPAWN, action: "allow" }, 0, "test");
    assert.ok(rule);
    const { svc } = buildService({ policy: { rules: [rule] } });
    const d = await svc.decide({ workerId: "w1", toolName: SPAWN, input: {}, agentId: "a1" });
    assert.equal(d.behavior, "deny");
  });

  it("records the deny in the policy event trail", async () => {
    const { svc, policyEvents } = buildService();
    await svc.decide({ workerId: "w1", toolName: REPORT, input: {}, agentId: "a1" });
    assert.deepEqual(policyEvents, [{ tool: REPORT, decision: "deny" }]);
  });
});
