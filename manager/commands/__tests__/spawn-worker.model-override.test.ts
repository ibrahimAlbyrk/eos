import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnWorkerHandler } from "../handlers/spawn-worker.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";
import { SqlBackedBackendResolver } from "../../../core/src/services/SqlBackedBackendResolver.ts";
import type { AgentBackend, AgentCapabilities, BackendDescriptor } from "../../../core/src/ports/AgentBackend.ts";
import type { BackendDefaults, ResolvedBackend } from "../../../core/src/ports/BackendDefaults.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import type { WorkerDefinitionRecord } from "../../../contracts/src/worker-definition.ts";

// The model override + combined-form split on the worker-SPAWN path. These run the
// REAL handler all the way to backend.start (the spawn chokepoint) and capture its
// input — the model + the resolved profile launch refs — by throwing a SENTINEL
// from start. A pre-start ValidationError (e.g. an un-billed metered guard) would
// reject BEFORE the sentinel, so reaching it also proves the spawn passed the guard.

const caps: AgentCapabilities = { interrupt: true, keystroke: false, rewind: false, runtimeModelSwitch: false, runtimePermissionSwitch: false };

const openaiDescriptor: BackendDescriptor = {
  kind: "openai", label: "OpenAI API", processModel: "in-process", billing: "metered",
  modelSource: "profile", capabilities: caps, models: { kind: "openai-compatible" },
  auth: "apikey", enabled: true, sessionStore: "eos-conversation", wireDialect: "openai-chat",
};
const claudeDescriptor: BackendDescriptor = {
  kind: "claude-cli", label: "Claude CLI", processModel: "out-of-process", billing: "subscription",
  modelSource: "request", capabilities: caps, models: { kind: "claude" },
  auth: "subscription", enabled: true, sessionStore: "claude-transcript",
};

const deepseekProfile: ResolvedBackend = {
  kind: "openai", model: "deepseek-chat", profileName: "deepseek", costMode: "billed",
  auth: { kind: "keychain", ref: "eos/deepseek" }, baseUrl: "https://api.deepseek.com",
};

const SENTINEL = "CAPTURED_START";

interface StartSink {
  kind?: string;
  model?: string;
  backendProfile?: string;
  auth?: unknown;
  baseUrl?: string;
}

function capturingBackend(descriptor: BackendDescriptor, sink: StartSink): AgentBackend {
  return {
    kind: descriptor.kind,
    descriptor,
    start: (async (input: { model: string; backendOptions: { spec: { backendProfile?: string }; auth?: unknown; baseUrl?: string } }) => {
      sink.kind = descriptor.kind;
      sink.model = input.model;
      sink.backendProfile = input.backendOptions.spec.backendProfile;
      sink.auth = input.backendOptions.auth;
      sink.baseUrl = input.backendOptions.baseUrl;
      throw new Error(SENTINEL);
    }) as never,
    attach: () => ({}) as never,
  };
}

function fakeContainer(def: Partial<WorkerDefinitionRecord>, sink: StartSink) {
  const record = { name: "w", description: "", whenToUse: "", body: "", source: "project", ...def } as WorkerDefinitionRecord;
  const openaiBackend = capturingBackend(openaiDescriptor, sink);
  const claudeCliBackend = capturingBackend(claudeDescriptor, sink);
  const backendMap = new Map<string, AgentBackend>([["openai", openaiBackend]]);
  const backends = {
    get: (k: string) => { const b = backendMap.get(k); if (!b) throw new Error(k); return b; },
    has: (k: string) => backendMap.has(k),
    descriptors: () => [...backendMap.values()].map((b) => b.descriptor),
  };
  const defaults: BackendDefaults = {
    profile: (name) => (name === "deepseek" ? deepseekProfile : null),
    roleDefaultName: () => null,
  };
  const workers = { findById: () => undefined } as unknown as WorkerRepo;
  const backendResolver = new SqlBackedBackendResolver(workers, defaults);
  return {
    listWorkerDefinitionRecords: () => [record],
    runtimeWorkerDefinitions: { listFor: () => [] },
    userSettings: { read: () => ({}) },
    config: { worker: { hydrateEnvFiles: false }, backends: { deepseek: {} } },
    backends,
    backendResolver,
    authResolver: { resolve: async () => ({ scheme: "none" as const }) },
    claudeCliBackend,
    ids: { newWorkerId: () => "w-test" },
    clock: { now: () => 0 },
    log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
  };
}

// The lone def in the fake container is named "w", so `from: "w"` selects it.
const run = async (def: Partial<WorkerDefinitionRecord>, body: Record<string, unknown>): Promise<StartSink> => {
  const sink: StartSink = {};
  const c = fakeContainer(def, sink);
  await assert.rejects(
    spawnWorkerHandler.run({}, { prompt: "go", cwd: "/repo", from: "w", ...body } as never, { c, requestId: "t" } as never),
    new RegExp(SENTINEL),
  );
  return sink;
};

describe("spawnWorkerHandler — model override on the worker-spawn path (PART A)", () => {
  it("backendProfile + model: resolves kind openai + the chosen model + the profile baseUrl/auth (override applied)", async () => {
    const sink = await run({ backendProfile: "deepseek", model: "deepseek-v4-pro" }, {});
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-v4-pro"); // overrides the profile's pinned deepseek-chat
    assert.equal(sink.backendProfile, "deepseek");
    assert.equal(sink.baseUrl, "https://api.deepseek.com");
    assert.deepEqual(sink.auth, { kind: "keychain", ref: "eos/deepseek" });
  });

  it("a non-profile claude def's model flows unchanged (override never fires)", async () => {
    const sink = await run({ model: "sonnet" }, {});
    assert.equal(sink.kind, "claude-cli");
    assert.equal(sink.model, "sonnet");
    assert.equal(sink.backendProfile, undefined);
  });
});

describe("spawnWorkerHandler — combined provider/model def form (PART B)", () => {
  it("model: deepseek/deepseek-v4-pro resolves to the deepseek profile + deepseek-v4-pro", async () => {
    const sink = await run({ model: "deepseek/deepseek-v4-pro" }, {});
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-v4-pro");
    assert.equal(sink.backendProfile, "deepseek");
    assert.equal(sink.baseUrl, "https://api.deepseek.com");
    assert.deepEqual(sink.auth, { kind: "keychain", ref: "eos/deepseek" });
  });

  it("an unconfigured-prefix model stays a plain claude model id (no false split)", async () => {
    const sink = await run({ model: "anthropic/claude-opus-4" }, {});
    assert.equal(sink.kind, "claude-cli");
    assert.equal(sink.model, "anthropic/claude-opus-4");
    assert.equal(sink.backendProfile, undefined);
  });
});

// The live bug: a deepseek (kind openai) orchestrator spawns a worker via the MCP
// spawn_worker tool; its Claude model param (opus/sonnet/haiku) became body.model and
// WON over the def's profile-bound model → the deepseek lane was driven with "sonnet"
// → DeepSeek 400 → worker died IDLE. A bare inherited body.model must never override a
// def's profile-bound model; only a model chosen FOR the profile may.
describe("spawnWorkerHandler — cross-provider model poisoning fix (PART C)", () => {
  it("def pins the deepseek profile (combined form) + WITH an inherited body.model=sonnet → keeps deepseek-v4-pro, NOT sonnet", async () => {
    const sink = await run({ model: "deepseek/deepseek-v4-pro" }, { model: "sonnet" });
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-v4-pro"); // the def's own model, not the parent's "sonnet"
    assert.equal(sink.backendProfile, "deepseek");
  });

  it("def pins backendProfile deepseek + model deepseek-v4-pro + body.model=opus → keeps deepseek-v4-pro, NOT opus", async () => {
    const sink = await run({ backendProfile: "deepseek", model: "deepseek-v4-pro" }, { model: "opus" });
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-v4-pro");
    assert.equal(sink.backendProfile, "deepseek");
  });

  it("a bare deepseek-profile def with NO model + body.model=opus → keeps the profile's pinned model (deepseek-chat), NOT opus", async () => {
    const sink = await run({ backendProfile: "deepseek" }, { model: "opus" });
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-chat"); // the profile's pinned default, never the Claude "opus"
    assert.equal(sink.backendProfile, "deepseek");
  });

  it("split-on-all-paths: def with backendProfile deepseek + a redundant deepseek/ slashed model never reaches the lane raw", async () => {
    const sink = await run({ backendProfile: "deepseek", model: "deepseek/deepseek-v4-pro" }, {});
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-v4-pro"); // prefix stripped, never the raw "deepseek/deepseek-v4-pro"
    assert.equal(sink.backendProfile, "deepseek");
  });

  it("no regression: a normal Claude worker's inherited body.model still flows to the claude lane", async () => {
    const sink = await run({}, { model: "sonnet" });
    assert.equal(sink.kind, "claude-cli");
    assert.equal(sink.model, "sonnet");
    assert.equal(sink.backendProfile, undefined);
  });
});

// The b106784 gap: the orchestrator's spawn-time model override (body.model) can
// be a combined "provider/model" form or a cross-provider bare model. Without the
// split + guard activation, these reached the API verbatim or on the wrong backend.
// PART D covers the fix:
//   1. body.model split (combined form like "deepseek/deepseek-v4-pro")
//   2. guard activation (bodyProfile threads as explicitProfileName)
//   3. belt-and-suspenders (model family mismatch on request-model backends)
describe("spawnWorkerHandler — combined body.model split + cross-provider guard (PART D)", () => {
  it("body.model 'deepseek/deepseek-v4-pro' splits to profile deepseek + model deepseek-v4-pro", async () => {
    const sink = await run({}, { model: "deepseek/deepseek-v4-pro" });
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-v4-pro"); // prefix stripped, never raw
    assert.equal(sink.backendProfile, "deepseek");
    assert.equal(sink.baseUrl, "https://api.deepseek.com");
    assert.deepEqual(sink.auth, { kind: "keychain", ref: "eos/deepseek" });
  });

  it("body.model 'deepseek/deepseek-v4-pro' with a matching def profile normalizes (redundant prefix stripped)", async () => {
    const sink = await run({ backendProfile: "deepseek" }, { model: "deepseek/deepseek-v4-pro" });
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-v4-pro"); // prefix stripped
    assert.equal(sink.backendProfile, "deepseek");
  });

  it("a matching Claude model on a Claude backend passes unchanged", async () => {
    const sink = await run({}, { model: "sonnet" });
    assert.equal(sink.kind, "claude-cli");
    assert.equal(sink.model, "sonnet");
    assert.equal(sink.backendProfile, undefined);
  });

  it("a matching non-Claude model on a profile backend passes (guard not triggered)", async () => {
    const sink = await run({ backendProfile: "deepseek" }, { model: "deepseek-reasoner", backendProfile: "deepseek" });
    assert.equal(sink.kind, "openai");
    assert.equal(sink.model, "deepseek-reasoner");
    assert.equal(sink.backendProfile, "deepseek");
  });
});

// Belt-and-suspenders: a bare cross-provider model on a request-model backend
// (e.g. claude-cli/sdk) must be rejected BEFORE reaching the API — never send
// "deepseek-v4-pro" to the Claude endpoint. The runSentinel helper catches
// SENTINEL (spawn passed), so rejection tests use a raw handler call.
describe("spawnWorkerHandler — belt-and-suspenders cross-provider rejection (PART E)", () => {
  const runReject = async (def: Partial<WorkerDefinitionRecord>, body: Record<string, unknown>): Promise<ValidationError> => {
    const record = { name: "w", description: "", whenToUse: "", body: "", source: "project", ...def } as WorkerDefinitionRecord;
    const sink: StartSink = {};
    const c = fakeContainer(record, sink) as Record<string, unknown>;
    try {
      await spawnWorkerHandler.run({}, { prompt: "go", cwd: "/repo", from: "w", ...body } as never, { c, requestId: "t" } as never);
      throw new Error("expected ValidationError but handler completed");
    } catch (e) {
      if (e instanceof ValidationError) return e;
      if (e instanceof Error && e.message === SENTINEL) throw new Error("expected rejection but spawn succeeded — model reached backend", { cause: e });
      throw e;
    }
  };

  it("rejects bare 'deepseek-v4-pro' on a claude backend with a clear cross-provider message", async () => {
    const err = await runReject({}, { model: "deepseek-v4-pro" });
    assert.ok(err.message.includes("deepseek-v4-pro"));
    assert.ok(err.message.includes("claude"));
    assert.ok(err.message.includes("<provider>/<model>"));
  });

  it("rejects bare 'gpt-4o' on a claude backend", async () => {
    const err = await runReject({}, { model: "gpt-4o" });
    assert.ok(err.message.includes("gpt-4o"));
    assert.ok(err.message.includes("claude"));
  });
});

// Unsupported-tier reject (Risk 1): an undefined tier ("ultra" on Claude, whose
// vocabulary is high/medium/low) passes resolveTier through untouched, then the same
// spawn-time gate rejects it — naming the valid tiers — instead of sending the bogus
// id to the API.
describe("spawnWorkerHandler — unsupported-tier rejection (PART F)", () => {
  const runReject = async (def: Partial<WorkerDefinitionRecord>, body: Record<string, unknown>): Promise<ValidationError> => {
    const record = { name: "w", description: "", whenToUse: "", body: "", source: "project", ...def } as WorkerDefinitionRecord;
    const sink: StartSink = {};
    const c = fakeContainer(record, sink) as Record<string, unknown>;
    try {
      await spawnWorkerHandler.run({}, { prompt: "go", cwd: "/repo", from: "w", ...body } as never, { c, requestId: "t" } as never);
      throw new Error("expected ValidationError but handler completed");
    } catch (e) {
      if (e instanceof ValidationError) return e;
      if (e instanceof Error && e.message === SENTINEL) throw new Error("expected rejection but the undefined tier reached the backend", { cause: e });
      throw e;
    }
  };

  it("rejects an undefined tier 'ultra' on the Claude backend, naming the valid tiers", async () => {
    const err = await runReject({}, { model: "ultra" });
    assert.ok(err.message.includes("ultra"));
    assert.ok(err.message.includes("high, medium, low"));
  });

  it("allows a defined tier 'medium' through to the backend (resolves to sonnet)", async () => {
    const sink = await run({}, { model: "medium" });
    assert.equal(sink.model, "sonnet");
  });
});
