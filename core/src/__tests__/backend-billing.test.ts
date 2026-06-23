import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMeteredBackend, meteredNeedsBilledIntent } from "../domain/backend-billing.ts";
import type { ResolvedBackend } from "../ports/BackendDefaults.ts";
import type { BackendDescriptor } from "../ports/AgentBackend.ts";

const caps = { interrupt: true, keystroke: false, rewind: false, runtimeModelSwitch: true, runtimePermissionSwitch: true };
const desc = (over: Partial<BackendDescriptor>): BackendDescriptor => ({
  kind: "claude-sdk", label: "x", processModel: "in-process", billing: "subscription",
  modelSource: "request", capabilities: caps, models: { kind: "claude" }, auth: "subscription", enabled: true, sessionStore: "claude-transcript", ...over,
});
const rb = (over: Partial<ResolvedBackend>): ResolvedBackend => ({ kind: "claude-cli", model: "opus", profileName: null, ...over });

describe("backend-billing guard", () => {
  it("subscription backends are never metered", () => {
    assert.equal(isMeteredBackend(desc({ billing: "subscription" })), false);
    // a subscription backend never needs billed intent, even with an unmarked costMode
    assert.equal(meteredNeedsBilledIntent(desc({ billing: "subscription" }), rb({})), false);
  });

  it("metered backends are metered", () => {
    assert.equal(isMeteredBackend(desc({ billing: "metered" })), true);
  });

  it("a metered backend must declare costMode:billed to pass", () => {
    assert.equal(meteredNeedsBilledIntent(desc({ billing: "metered" }), rb({})), true);
    assert.equal(meteredNeedsBilledIntent(desc({ billing: "metered" }), rb({ costMode: "included" })), true);
    assert.equal(meteredNeedsBilledIntent(desc({ billing: "metered" }), rb({ costMode: "billed" })), false);
  });
});
