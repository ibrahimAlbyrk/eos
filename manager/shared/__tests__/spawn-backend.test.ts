import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnBackendError } from "../spawn-backend.ts";
import type { AgentBackend, AgentCapabilities } from "../../../core/src/ports/AgentBackend.ts";
import type { ResolvedBackend } from "../../../core/src/ports/BackendDefaults.ts";

const caps: AgentCapabilities = { interrupt: true, keystroke: false, runtimeModelSwitch: false, runtimePermissionSwitch: false };
function backend(over: { kind?: string; billing?: "subscription" | "metered"; enabled?: boolean }): AgentBackend {
  const kind = over.kind ?? "claude-sdk";
  return {
    kind,
    descriptor: {
      kind, label: kind, processModel: "in-process", billing: over.billing ?? "subscription",
      modelSource: "request", capabilities: caps, models: { kind: "claude" }, auth: "subscription", enabled: over.enabled ?? true,
      sessionStore: "claude-transcript",
    },
    start: async () => ({}) as never,
    attach: () => ({}) as never,
  };
}
const rb = (over: Partial<ResolvedBackend>): ResolvedBackend => ({ kind: "claude-sdk", model: "opus", profileName: null, ...over });

describe("spawnBackendError — spawn-time backend guard", () => {
  it("allows a subscription backend regardless of how it was selected", () => {
    assert.equal(spawnBackendError(backend({ billing: "subscription" }), rb({}), false), null);
    assert.equal(spawnBackendError(backend({ billing: "subscription" }), rb({}), true), null);
  });

  it("rejects a metered backend without costMode:billed even on a non-explicit (inherited/profile) pick", () => {
    // The bug: the guard used to only run when body.backendKind was set, so an
    // inherited/profile metered backend (explicit=false) slipped through.
    assert.ok(spawnBackendError(backend({ billing: "metered" }), rb({}), false));
    assert.ok(spawnBackendError(backend({ billing: "metered" }), rb({ costMode: "included" }), false));
  });

  it("allows a metered backend once it declares costMode:billed", () => {
    assert.equal(spawnBackendError(backend({ billing: "metered" }), rb({ costMode: "billed" }), true), null);
  });

  it("rejects an explicit pick of a disabled backend, but allows it via profile/inherit", () => {
    assert.ok(spawnBackendError(backend({ enabled: false }), rb({}), true));
    assert.equal(spawnBackendError(backend({ enabled: false }), rb({}), false), null);
  });
});
