import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isMeteredBackend, meteredNeedsBilledIntent } from "../domain/backend-billing.ts";
import type { ResolvedBackend } from "../ports/BackendDefaults.ts";

const rb = (over: Partial<ResolvedBackend>): ResolvedBackend => ({ kind: "claude-cli", model: "opus", profileName: null, ...over });

describe("backend-billing guard", () => {
  it("subscription kinds (claude-cli, claude-sdk) are never metered", () => {
    assert.equal(isMeteredBackend(rb({ kind: "claude-cli" })), false);
    assert.equal(isMeteredBackend(rb({ kind: "claude-sdk" })), false);
    // a subscription kind never needs billed intent, even unmarked
    assert.equal(meteredNeedsBilledIntent(rb({ kind: "claude-sdk" })), false);
  });

  it("metered API kinds are metered", () => {
    assert.equal(isMeteredBackend(rb({ kind: "anthropic-api" })), true);
    assert.equal(isMeteredBackend(rb({ kind: "openai" })), true);
    assert.equal(isMeteredBackend(rb({ kind: "codex" })), true);
  });

  it("a metered profile must declare costMode:billed to pass", () => {
    assert.equal(meteredNeedsBilledIntent(rb({ kind: "openai" })), true);
    assert.equal(meteredNeedsBilledIntent(rb({ kind: "openai", costMode: "included" })), true);
    assert.equal(meteredNeedsBilledIntent(rb({ kind: "openai", costMode: "billed" })), false);
  });
});
