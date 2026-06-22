import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolicyGatewayService, type PolicyGatewayServiceDeps } from "../services/PolicyGatewayService.ts";
import { compileRule, type Policy } from "../domain/policy.ts";
import type { PermissionMode } from "../domain/permission-mode.ts";
import type { ToolScope } from "../../../contracts/src/worker-definition.ts";

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

describe("PolicyGatewayService — worker-definition tool scope (rung 2.5)", () => {
  it("denies a tool outside the allowlist (read-only type denies Bash + Edit)", async () => {
    const { svc } = buildService({ scope: READONLY });
    for (const tool of ["Bash", "Edit", "Write"]) {
      const d = await svc.decide({ workerId: "w1", toolName: tool, input: {} });
      assert.equal(d.behavior, "deny", `${tool} should be denied`);
      assert.ok("message" in d && String(d.message).includes("not in this worker definition's allowed tools"));
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

  it("Eos control tools bypass the worker allowlist (a read-only worker can still report back + consult peers)", async () => {
    // allow: Read/Grep/Glob — none of these are the comms tools, yet a fenced
    // worker MUST still report to its parent and use the peer mesh.
    const { svc } = buildService({ scope: READONLY });
    for (const tool of [
      "mcp__worker__send_message_to_parent",
      "mcp__worker__ask_peer",
      "mcp__worker__respond_to_peer",
      "mcp__orchestrator__spawn_worker",
    ]) {
      assert.equal(
        (await svc.decide({ workerId: "w1", toolName: tool, input: {} })).behavior,
        "allow",
        `${tool} should bypass the worker allowlist`,
      );
    }
  });

  it("an explicit deny cannot strand control tools, but external MCP stays denied", async () => {
    const denyAllMcp: ToolScope = { allow: [], deny: ["mcp__*"], editRegex: null };
    const { svc } = buildService({ scope: denyAllMcp });
    // external MCP server → still denied by the glob.
    assert.equal((await svc.decide({ workerId: "w1", toolName: "mcp__github__create_pr", input: {} })).behavior, "deny");
    // Eos control plane → exempt, the report tool survives deny-all-mcp.
    assert.equal((await svc.decide({ workerId: "w1", toolName: "mcp__worker__send_message_to_parent", input: {} })).behavior, "allow");
  });

  it("adversarial scope can strip NO control tool: restrictive allow (omits them) + deny mcp__worker__*/mcp__*", async () => {
    // The invariant the operator wants enforced: a worker definition's allow/deny
    // can never add or remove an Eos control-plane tool. This is the worst case —
    // an allowlist that omits every control tool AND deny globs that explicitly
    // name them — yet send_message_to_parent + the peer mesh + spawn + gateway all
    // survive, while a genuine external MCP tool under the same scope is stripped.
    const adversarial: ToolScope = {
      allow: ["Read"],
      deny: ["mcp__worker__*", "mcp__orchestrator__*", "mcp__gateway__*", "mcp__*"],
      editRegex: null,
    };
    const { svc } = buildService({ scope: adversarial });
    for (const tool of [
      "mcp__worker__send_message_to_parent",
      "mcp__worker__list_peers",
      "mcp__worker__ask_peer",
      "mcp__worker__respond_to_peer",
      "mcp__orchestrator__spawn_worker",
      "mcp__gateway__decide",
    ]) {
      assert.equal(
        (await svc.decide({ workerId: "w1", toolName: tool, input: {} })).behavior,
        "allow",
        `${tool} must survive an adversarial allow/deny`,
      );
    }
    // The same scope still strips an external (non-control) MCP tool.
    assert.equal((await svc.decide({ workerId: "w1", toolName: "mcp__github__create_pr", input: {} })).behavior, "deny");
  });

  it("command-scoped deny (db-migrator example): Bash(git push:*) denies git push, allows other Bash", async () => {
    // The §3.2 db-migrator scope: Bash is broadly allowed, git push specifically denied.
    const dbMigrator: ToolScope = {
      allow: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "mcp__*"],
      deny: ["Bash(git push:*)"],
      editRegex: null,
    };
    const { svc } = buildService({ scope: dbMigrator });
    // git push → denied by the command-scoped deny.
    const pushed = await svc.decide({ workerId: "w1", toolName: "Bash", input: { command: "git push origin main" } });
    assert.equal(pushed.behavior, "deny");
    // other Bash → in allow, not denied → falls through to acceptEdits ask (shell).
    void svc.decide({ workerId: "w1", toolName: "Bash", input: { command: "git status" } });
    // Read in allow → allowed.
    assert.equal((await svc.decide({ workerId: "w1", toolName: "Read", input: {} })).behavior, "allow");
  });

  it("command-scoped allowlist: Bash(npm:*) permits npm, denies other Bash", async () => {
    const npmOnly: ToolScope = { allow: ["Read", "Bash(npm:*)"], deny: [], editRegex: null };
    const { svc } = buildService({ scope: npmOnly });
    // npm test ∈ allow → falls through → acceptEdits asks for shell.
    const npm = buildService({ scope: npmOnly });
    void npm.svc.decide({ workerId: "w1", toolName: "Bash", input: { command: "npm test" } });
    assert.deepEqual(npm.policyEvents, [{ tool: "Bash", decision: "ask" }]);
    // git status NOT in allow → denied.
    assert.equal((await svc.decide({ workerId: "w1", toolName: "Bash", input: { command: "git status" } })).behavior, "deny");
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
