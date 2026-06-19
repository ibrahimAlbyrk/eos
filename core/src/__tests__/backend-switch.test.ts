import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canHandoffBackend, planBackendSwitch } from "../domain/backend-switch.ts";
import type { BackendDescriptor } from "../ports/AgentBackend.ts";

function desc(over: Partial<BackendDescriptor> = {}): BackendDescriptor {
  return {
    kind: "claude-cli", label: "X", processModel: "out-of-process", billing: "subscription",
    modelSource: "request", capabilities: { interrupt: true, keystroke: true, runtimeModelSwitch: true, runtimePermissionSwitch: true },
    models: { kind: "claude" }, auth: "subscription", enabled: true, sessionStore: "claude-transcript",
    ...over,
  };
}

const cli = desc({ kind: "claude-cli", sessionStore: "claude-transcript" });
const sdk = desc({ kind: "claude-sdk", sessionStore: "claude-transcript" });
// Enabled so these fixtures isolate the sessionStore check (the disabled case has
// its own dedicated test); metered API lanes keep no resumable store.
const api = desc({ kind: "anthropic-api", sessionStore: "none", billing: "metered", enabled: true });

describe("canHandoffBackend", () => {
  it("allows two enabled backends sharing a non-none conversation store", () => {
    assert.deepEqual(canHandoffBackend(cli, sdk), { ok: true });
    assert.deepEqual(canHandoffBackend(sdk, cli), { ok: true });
  });

  it("rejects switching to the same backend", () => {
    const r = canHandoffBackend(cli, desc({ kind: "claude-cli" }));
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /already on this backend/);
  });

  it("rejects a disabled target", () => {
    const r = canHandoffBackend(cli, desc({ kind: "claude-sdk", enabled: false }));
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /not enabled/);
  });

  it("rejects when either backend has no resumable store (metered lanes)", () => {
    assert.equal(canHandoffBackend(cli, api).ok, false);          // target none
    assert.equal(canHandoffBackend(api, cli).ok, false);          // source none
  });

  it("rejects incompatible (different non-none) stores", () => {
    const other = desc({ kind: "other", sessionStore: "other-store" as never });
    const r = canHandoffBackend(cli, other);
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.reason : "", /incompatible/);
  });
});

describe("planBackendSwitch", () => {
  it("allows a live IDLE worker and flags it for a stop", () => {
    const p = planBackendSwitch({ state: "IDLE", sessionId: "s1", isLive: true, source: cli, target: sdk });
    assert.deepEqual(p, { ok: true, needsStop: true });
  });

  it("allows a dead SUSPENDED/DONE worker with no stop needed", () => {
    assert.deepEqual(planBackendSwitch({ state: "SUSPENDED", sessionId: "s1", isLive: false, source: cli, target: sdk }), { ok: true, needsStop: false });
    assert.deepEqual(planBackendSwitch({ state: "DONE", sessionId: "s1", isLive: false, source: sdk, target: cli }), { ok: true, needsStop: false });
  });

  it("rejects a worker with no session to hand off", () => {
    const p = planBackendSwitch({ state: "IDLE", sessionId: null, isLive: true, source: cli, target: sdk });
    assert.equal(p.ok, false);
    assert.match(p.ok === false ? p.reason : "", /no recorded session/);
  });

  it("rejects a busy/transitional worker (would lose the in-flight turn)", () => {
    for (const state of ["WORKING", "SPAWNING", "ENDING", "KILLING"]) {
      const p = planBackendSwitch({ state, sessionId: "s1", isLive: true, source: cli, target: sdk });
      assert.equal(p.ok, false, `state ${state} must be rejected`);
      assert.match(p.ok === false ? p.reason : "", /busy/);
    }
  });

  it("propagates a handoff incompatibility before checking state", () => {
    const p = planBackendSwitch({ state: "IDLE", sessionId: "s1", isLive: true, source: cli, target: api });
    assert.equal(p.ok, false);
    assert.match(p.ok === false ? p.reason : "", /resumable conversation store/);
  });
});
