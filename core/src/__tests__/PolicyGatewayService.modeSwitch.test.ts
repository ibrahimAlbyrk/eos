import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PolicyGatewayService, type PolicyGatewayServiceDeps } from "../services/PolicyGatewayService.ts";
import type { Policy } from "../domain/policy.ts";
import type { PermissionMode } from "../domain/permission-mode.ts";

// The claude-sdk lane never applies a mode to the live session — the gateway IS
// the enforcement point, re-resolving the worker's mode on every decision.
// These tests pin the contract that makes runtime full-access switches real:
// the same service, asked across a mode flip, gates the next call.
describe("PolicyGatewayService — live permission-mode switch re-gates", () => {
  function build() {
    const policy: Policy = { default: "ask", ttlMs: 1000, rules: [] };
    let mode: PermissionMode = "bypassPermissions";
    const pendings: Array<{ id: string; toolName: string }> = [];
    const deps = {
      pending: {
        insert(row: { id: string; toolName: string }) { pendings.push({ id: row.id, toolName: row.toolName }); },
        findById: () => null, listUnresolved: () => [], resolve: () => true, sweepExpired: () => 0, deleteByWorker() {},
      },
      events: { append: () => 0, patchPayload() {}, list: () => [], deleteByWorker() {} },
      bus: { publish() {}, subscribe: () => () => {} },
      clock: { now: () => 1000 },
      ids: { newPendingId: () => `p${pendings.length + 1}` },
      modeResolver: { resolveFor: () => mode },
      getPolicy: () => policy,
    } as unknown as PolicyGatewayServiceDeps;
    return { svc: new PolicyGatewayService(deps), pendings, setMode: (m: PermissionMode) => { mode = m; } };
  }

  it("full access allows; flipping to acceptEdits parks the very next shell call until resolved", async () => {
    const { svc, pendings, setMode } = build();
    const first = await svc.decide({ workerId: "w1", toolName: "Bash", input: { command: "ls" } });
    assert.equal(first.behavior, "allow");
    assert.equal(pendings.length, 0, "full access must not create a pending");

    setMode("acceptEdits");
    let settled: unknown = null;
    const second = svc.decide({ workerId: "w1", toolName: "Bash", input: { command: "ls" } })
      .then((d) => { settled = d; return d; });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settled, null, "the call must BLOCK until the pending is resolved");
    assert.deepEqual(pendings, [{ id: "p1", toolName: "Bash" }]);

    svc.resolvePending({ id: "p1", decision: { behavior: "deny", message: "user denied" } });
    assert.equal((await second).behavior, "deny");
  });

  it("the reverse flip (acceptEdits → full access) stops asking", async () => {
    const { svc, pendings, setMode } = build();
    setMode("acceptEdits");
    let parkedSettled = false;
    const parked = svc.decide({ workerId: "w1", toolName: "Bash", input: { command: "ls" } })
      .then((d) => { parkedSettled = true; return d; });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(pendings.length, 1);

    setMode("bypassPermissions");
    const d = await svc.decide({ workerId: "w1", toolName: "Bash", input: { command: "ls" } });
    assert.equal(d.behavior, "allow");
    assert.equal(pendings.length, 1, "no new pending in full access");

    // The earlier parked ask is untouched by the flip — it resolves only when
    // answered (deny here, so the test leaves no dangling resolver behind).
    assert.equal(parkedSettled, false);
    svc.resolvePending({ id: "p1", decision: { behavior: "deny", message: "stale" } });
    assert.equal((await parked).behavior, "deny");
  });
});
