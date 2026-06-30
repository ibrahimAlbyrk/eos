import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { spawnWorkerHandler } from "../handlers/spawn-worker.ts";
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
