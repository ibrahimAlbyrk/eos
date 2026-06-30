// API-lane policy gating — cross-lane parity. The in-process gate (makePolicyToolGate
// over the SAME PolicyGatewayService the SDK/CLI lanes use) must give the bare-named
// built-ins the SAME verdicts: worker-definition allow/deny, editRegex, command-scoped
// Bash deny, permission-mode ask/allow, blocked-builtin deny, and the policy rewrite
// (updatedInput) propagation (Q0a). Plus the two Task-isolation invariants: the Task
// item is absent from an orchestrator surface, and a sub-agent gate (agentId set) is
// hard-denied Eos control tools at rung-0.5.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PolicyGatewayService, type PolicyGatewayServiceDeps } from "../../core/src/services/PolicyGatewayService.ts";
import type { Policy } from "../../core/src/domain/policy.ts";
import type { PermissionMode } from "../../core/src/domain/permission-mode.ts";
import type { ToolScope } from "../../contracts/src/worker-definition.ts";
import { makePolicyToolGate, type PolicyDecider } from "../backends/PolicyToolGate.ts";
import { buildBuiltinSurface, buildLaneSurface, type LaneTooling } from "../backends/lane-tooling.ts";
import { createBuiltinToolRegistry } from "../../infra/src/tools/builtins/registry.ts";
import { createNodeToolFileSystem } from "../../infra/src/tools/NodeToolFileSystem.ts";
import { createNodeProcessRunner } from "../../infra/src/tools/NodeProcessRunner.ts";

const registry = createBuiltinToolRegistry({ fs: createNodeToolFileSystem(), proc: createNodeProcessRunner() });

// The real gateway with fake I/O deps (mirrors the core PolicyGatewayService tests),
// wrapped by the REAL in-process gate adapter (the same shape as container.sdkPolicy).
function buildGate(opts: { mode?: PermissionMode; scope?: ToolScope | null; agentId?: string } = {}) {
  const policy: Policy = { default: "ask", ttlMs: 1000, rules: [] };
  const deps = {
    pending: { insert() {}, findById: () => null, listUnresolved: () => [], resolve: () => true, sweepExpired: () => 0, deleteByWorker() {} },
    events: { append: () => 1, patchPayload() {}, list: () => [], deleteByWorker() {} },
    bus: { publish() {}, subscribe: () => () => {} },
    clock: { now: () => 1000 },
    ids: { newPendingId: () => "p1" },
    modeResolver: { resolveFor: () => opts.mode ?? "acceptEdits" },
    toolScopeResolver: { resolveFor: () => opts.scope ?? null },
    getPolicy: () => policy,
  } as unknown as PolicyGatewayServiceDeps;
  const svc = new PolicyGatewayService(deps);
  const decider: PolicyDecider = {
    async decide(i) {
      const d = await svc.decide(i);
      return { behavior: d.behavior === "allow" ? "allow" : "deny", message: d.message, updatedInput: d.updatedInput };
    },
  };
  const gate = makePolicyToolGate("w-api", decider, opts.agentId ? { agentId: opts.agentId } : undefined);
  return { svc, gate };
}

describe("API-lane gating — worker-definition allow/deny + editRegex (bare names)", () => {
  it("editRegex denies an Edit outside the allowed paths, allows one inside", async () => {
    const { gate } = buildGate({ mode: "bypassPermissions", scope: { allow: [], deny: [], editRegex: "(^|/)src/.*\\.ts$" } });
    const out = await gate.decide("Edit", { file_path: "/repo/app/ui/x.ts" });
    assert.equal(out.allow, false);
    assert.match(out.message ?? "", /allowed paths/);
    assert.equal((await gate.decide("Write", { file_path: "/repo/src/a.ts", content: "" })).allow, true);
  });

  it("a command-scoped Bash deny blocks the matching command, allows others", async () => {
    const { gate } = buildGate({ mode: "bypassPermissions", scope: { allow: [], deny: ["Bash(rm:*)"], editRegex: null } });
    assert.equal((await gate.decide("Bash", { command: "rm -rf /tmp/x" })).allow, false);
    assert.equal((await gate.decide("Bash", { command: "ls -la" })).allow, true);
  });

  it("a plain-name deny blocks the whole tool", async () => {
    const { gate } = buildGate({ mode: "bypassPermissions", scope: { allow: ["Read", "Grep"], deny: [], editRegex: null } });
    const out = await gate.decide("Bash", { command: "ls" });
    assert.equal(out.allow, false);
    assert.match(out.message ?? "", /not in this worker definition's allowed tools/);
  });
});

describe("API-lane gating — permission mode (bare names)", () => {
  it("bypassPermissions allows shell + edits", async () => {
    const { gate } = buildGate({ mode: "bypassPermissions" });
    assert.equal((await gate.decide("Bash", { command: "ls" })).allow, true);
    assert.equal((await gate.decide("Edit", { file_path: "/x", old_string: "a", new_string: "b" })).allow, true);
  });

  it("acceptEdits allows a fileEdit (bare Write classifies as fileEdit)", async () => {
    const { gate } = buildGate({ mode: "acceptEdits" });
    assert.equal((await gate.decide("Write", { file_path: "/x", content: "" })).allow, true);
  });

  it("acceptEdits ASKS for shell, then a human-resolved allow with edited input flows through (Q0a rewrite)", async () => {
    const { svc, gate } = buildGate({ mode: "acceptEdits" });
    const pending = gate.decide("Bash", { command: "ls" }); // shell → ask → parks
    // Resolve the parked 'ask' as a human-edited approval (rewritten command).
    svc.resolvePending({ id: "p1", decision: { behavior: "allow", updatedInput: { command: "ls -la" } } });
    assert.deepEqual(await pending, { allow: true, updatedInput: { command: "ls -la" } });
  });
});

describe("API-lane gating — blocked builtins are hard-denied before policy", () => {
  it("Workflow and AskUserQuestion deny with their tool-keyed message", async () => {
    const { gate } = buildGate({ mode: "bypassPermissions" });
    const wf = await gate.decide("Workflow", {});
    assert.equal(wf.allow, false);
    assert.match(wf.message ?? "", /mcp__orchestrator__workflow/);
    const aq = await gate.decide("AskUserQuestion", {});
    assert.equal(aq.allow, false);
    assert.match(aq.message ?? "", /mcp__orchestrator__ask_user/);
  });
});

describe("API-lane surface — orchestrator Task stripping + built-in parity", () => {
  const emptyControl = (): LaneTooling => ({ items: [], tools: new Map() });

  it("a non-orchestrator surface OFFERS Task; an orchestrator surface does NOT", () => {
    const worker = buildLaneSurface(registry, emptyControl(), { cwd: "/repo", isOrchestrator: false });
    const orch = buildLaneSurface(registry, emptyControl(), { cwd: "/repo", isOrchestrator: true });
    assert.ok(worker.items.some((i) => i.name === "Task"), "worker surface offers Task");
    assert.ok(!orch.items.some((i) => i.name === "Task"), "orchestrator surface omits Task");
    // Both surfaces carry the bare-named built-ins (Task stripping is the only delta).
    for (const name of ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]) {
      assert.ok(worker.items.some((i) => i.name === name), `worker offers ${name}`);
      assert.ok(orch.items.some((i) => i.name === name), `orchestrator offers ${name}`);
    }
  });

  it("the worker-definition allow/deny pre-filters the built-in surface", () => {
    const readonly = buildBuiltinSurface(registry, { cwd: "/repo", isOrchestrator: false, scope: { allow: ["Read", "Grep"], deny: [], editRegex: null } });
    const names = readonly.items.map((i) => i.name);
    assert.deepEqual(names.sort(), ["Grep", "Read"]);
    assert.ok(!readonly.tools.has("Bash"), "a denied tool is not offered to the model");
  });

  it("a command-scoped allow still offers the tool name (no over-strip)", () => {
    const surface = buildBuiltinSurface(registry, { cwd: "/repo", isOrchestrator: false, scope: { allow: ["Bash(git:*)", "Read"], deny: [], editRegex: null } });
    assert.ok(surface.tools.has("Bash"), "Bash stays offered under a command-scoped allow");
  });
});

describe("API-lane gating — sub-agent control-tool isolation (rung-0.5)", () => {
  it("a sub-agent gate (agentId set) is hard-denied Eos control tools; the main gate is not", async () => {
    const child = buildGate({ mode: "bypassPermissions", agentId: "sub-1" }).gate;
    const parent = buildGate({ mode: "bypassPermissions" }).gate;
    const denied = await child.decide("mcp__orchestrator__spawn_worker", {});
    assert.equal(denied.allow, false);
    assert.match(denied.message ?? "", /subagents cannot use Eos control tools/);
    // The same control tool is allowed for the main loop (no agentId).
    assert.equal((await parent.decide("mcp__orchestrator__spawn_worker", {})).allow, true);
    // The sub-agent still gets ordinary built-ins.
    assert.equal((await child.decide("Read", { file_path: "/x" })).allow, true);
  });
});
