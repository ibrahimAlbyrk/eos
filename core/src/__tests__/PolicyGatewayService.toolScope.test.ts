import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolicyGatewayService, type PolicyGatewayServiceDeps } from "../services/PolicyGatewayService.ts";
import { compileRule, type Policy } from "../domain/policy.ts";
import type { PermissionMode } from "../domain/permission-mode.ts";
import type { ToolScope } from "../../../contracts/src/worker-type.ts";

interface PolicyEvent { tool: string; decision: string }

function buildService(opts: { mode?: PermissionMode; policy?: Partial<Policy>; scope?: ToolScope | null } = {}) {
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
    toolScopeResolver: { resolveFor: () => opts.scope ?? null },
    getPolicy: () => policy,
  } as unknown as PolicyGatewayServiceDeps;
  return { svc: new PolicyGatewayService(deps), policyEvents };
}

const READONLY: ToolScope = { allow: ["Read", "Grep", "Glob"], deny: [], editRegex: null };

describe("PolicyGatewayService — worker-type tool scope (rung 2.5)", () => {
  it("denies a tool outside the allowlist (read-only type denies Bash + Edit)", async () => {
    const { svc } = buildService({ scope: READONLY });
    for (const tool of ["Bash", "Edit", "Write"]) {
      const d = await svc.decide({ workerId: "w1", toolName: tool, input: {} });
      assert.equal(d.behavior, "deny", `${tool} should be denied`);
      assert.ok("message" in d && String(d.message).includes("not in this worker type's allowed tools"));
    }
  });

  it("a tool in the allowlist falls through to the mode verdict (NOT auto-allowed)", async () => {
    // Read ∈ allow → falls through → acceptEdits allows read.
    const allowed = buildService({ scope: READONLY });
    assert.equal((await allowed.svc.decide({ workerId: "w1", toolName: "Read", input: {} })).behavior, "allow");

    // WebFetch ∈ allow but acceptEdits ASKS for network — proves the rung does
    // not short-circuit allow (else this would be an immediate allow).
    const network: ToolScope = { allow: ["WebFetch"], deny: [], editRegex: null };
    const asked = buildService({ scope: network });
    void asked.svc.decide({ workerId: "w1", toolName: "WebFetch", input: {} }); // parks on ask
    assert.deepEqual(asked.policyEvents, [{ tool: "WebFetch", decision: "ask" }]);
  });

  it("denylist subtracts even with an empty (inherit-all) allowlist", async () => {
    const denyBash: ToolScope = { allow: [], deny: ["Bash"], editRegex: null };
    const { svc } = buildService({ scope: denyBash });
    assert.equal((await svc.decide({ workerId: "w1", toolName: "Bash", input: {} })).behavior, "deny");
    // empty allow ⇒ inherit-all: Read still passes through to the mode verdict.
    assert.equal((await svc.decide({ workerId: "w1", toolName: "Read", input: {} })).behavior, "allow");
  });

  it("glob patterns match (mcp__* prefix)", async () => {
    const noMcp: ToolScope = { allow: [], deny: ["mcp__*"], editRegex: null };
    const { svc } = buildService({ scope: noMcp });
    assert.equal((await svc.decide({ workerId: "w1", toolName: "mcp__github__create_pr", input: {} })).behavior, "deny");
  });

  it("a broad policy.yaml allow does NOT defeat the type denylist (rung sits above policy.yaml)", async () => {
    const rule = compileRule({ tool: "Bash", action: "allow" }, 0, "test");
    assert.ok(rule);
    const denyBash: ToolScope = { allow: [], deny: ["Bash"], editRegex: null };
    const { svc } = buildService({ scope: denyBash, policy: { rules: [rule] } });
    const d = await svc.decide({ workerId: "w1", toolName: "Bash", input: {} });
    assert.equal(d.behavior, "deny");
  });

  it("no scope (untyped worker) → rung skipped, behaves exactly as before", async () => {
    const { svc } = buildService({ scope: null });
    assert.equal((await svc.decide({ workerId: "w1", toolName: "Edit", input: { file_path: "/x" } })).behavior, "allow");
  });

  it("editRegex confines fileEdits to matching paths (Phase 3)", async () => {
    const scope: ToolScope = { allow: [], deny: [], editRegex: "(^|/)src/.*\\.ts$" };
    const { svc } = buildService({ scope });
    // In-scope edit → falls through to acceptEdits (allow).
    assert.equal((await svc.decide({ workerId: "w1", toolName: "Edit", input: { file_path: "/repo/src/a.ts" } })).behavior, "allow");
    // Out-of-scope edit → deny.
    const d = await svc.decide({ workerId: "w1", toolName: "Write", input: { file_path: "/repo/app/ui/b.ts" } });
    assert.equal(d.behavior, "deny");
    assert.ok("message" in d && String(d.message).includes("allowed paths"));
    // editRegex never gates non-edit tools: Read passes through to the mode verdict.
    assert.equal((await svc.decide({ workerId: "w1", toolName: "Read", input: { file_path: "/repo/app/ui/b.ts" } })).behavior, "allow");
  });

  it("invalid editRegex is ignored (fails open on the regex axis, not bricking edits)", async () => {
    const scope: ToolScope = { allow: [], deny: [], editRegex: "(unclosed" };
    const { svc } = buildService({ scope });
    assert.equal((await svc.decide({ workerId: "w1", toolName: "Edit", input: { file_path: "/x.ts" } })).behavior, "allow");
  });
});
