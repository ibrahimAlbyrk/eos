import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnBackendError, resolveSpawnBackend } from "../spawn-backend.ts";
import { SqlBackedBackendResolver } from "../../../core/src/services/SqlBackedBackendResolver.ts";
import type { AgentBackend, AgentCapabilities, BackendDescriptor } from "../../../core/src/ports/AgentBackend.ts";
import type { BackendDefaults, ResolvedBackend } from "../../../core/src/ports/BackendDefaults.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import type { Container } from "../../container.ts";

const caps: AgentCapabilities = { interrupt: true, keystroke: false, rewind: false, runtimeModelSwitch: false, runtimePermissionSwitch: false };
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

// A metered in-process backend whose descriptor is selectable (enabled), reached
// by a named profile. Mirrors the real openai descriptor (billing metered,
// modelSource profile, apikey auth — so the subscription creds safety net is skipped).
const openaiDescriptor: BackendDescriptor = {
  kind: "openai", label: "OpenAI API", processModel: "in-process", billing: "metered",
  modelSource: "profile", capabilities: caps, models: { kind: "openai-compatible" },
  auth: "apikey", enabled: true, sessionStore: "eos-conversation", wireDialect: "openai-chat",
};

function fakeContainer(profile: ResolvedBackend): Container {
  const openaiBackend: AgentBackend = {
    kind: "openai", descriptor: openaiDescriptor,
    start: async () => ({}) as never, attach: () => ({}) as never,
  };
  const backendMap = new Map<string, AgentBackend>([["openai", openaiBackend]]);
  const backends = {
    get: (k: string) => { const b = backendMap.get(k); if (!b) throw new Error(k); return b; },
    has: (k: string) => backendMap.has(k),
    descriptors: () => [...backendMap.values()].map((b) => b.descriptor),
  };
  const defaults: BackendDefaults = {
    profile: (name) => (name === "deepseek" ? profile : null),
    roleDefaultName: () => null,
  };
  const workers = { findById: () => undefined } as unknown as WorkerRepo;
  const backendResolver = new SqlBackedBackendResolver(workers, defaults);
  const authResolver = { resolve: async () => ({ scheme: "none" as const }) };
  const log = { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} };
  return { backends, backendResolver, authResolver, log } as unknown as Container;
}

describe("resolveSpawnBackend — explicit profile pick", () => {
  it("resolves a billed metered profile via the resolver (not the bare-kind branch) and passes the guard", async () => {
    const profile: ResolvedBackend = {
      kind: "openai", model: "deepseek-chat", profileName: "deepseek", costMode: "billed",
      auth: { kind: "keychain", ref: "eos/deepseek" }, baseUrl: "https://api.deepseek.com",
    };
    const c = fakeContainer(profile);
    const resolved = await resolveSpawnBackend(c, { explicitProfileName: "deepseek", isOrchestrator: true });
    assert.equal(resolved.kind, "openai");
    assert.equal(resolved.model, "deepseek-chat");
    assert.equal(resolved.costMode, "billed");
    assert.equal(resolved.profileName, "deepseek");
    // Not rejected as bare-metered: the billed opt-in carries through.
    assert.equal(spawnBackendError(c.backends.get(resolved.kind), resolved, true), null);
  });
});
