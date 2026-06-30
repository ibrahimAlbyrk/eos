import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { FilePromptSource } from "../../infra/src/prompt/FilePromptSource.ts";
import { PromptRegistry } from "../../core/src/services/PromptRegistry.ts";
import { PromptService } from "../../core/src/services/PromptService.ts";
import { assembleSystemPrompt } from "../../core/src/use-cases/AssembleSystemPrompt.ts";
import type { SessionSpawnContext } from "../../core/src/use-cases/AssembleSystemPrompt.ts";
import { toFragment, type Fragment, type RawPrompt } from "../../core/src/domain/prompt.ts";
import { parsePrompt } from "../../core/src/services/prompt-parse.ts";
import { selectInjectableMemory } from "../../core/src/services/select-injectable-memory.ts";
import { composeAppendedPrompt } from "../../core/src/services/compose-appended-prompt.ts";
import type { MemoryDoc } from "../../core/src/ports/MemoryProvider.ts";
import { TOOL_NAME_VARS } from "../prompt-tool-names.ts";

import { createInProcessEnvFactory } from "../backends/in-process-env.ts";
import { createInProcessBackend } from "../../infra/src/backends/InProcessBackend.ts";
import type { AgentEvent, AgentLaunchSpec } from "../../core/src/ports/AgentBackend.ts";
import type { AuthResolver } from "../../core/src/ports/AuthResolver.ts";
import type { ModelClient, ModelTurn } from "../../core/src/ports/ModelClient.ts";
import type { RuntimeTool, ToolGate } from "../../core/src/use-cases/ToolRuntime.ts";

import { validateAddBackend } from "../routes/backends.ts";
import type { AddBackendRequest } from "../../contracts/src/http.ts";
import type { ModelPrice } from "../shared/config.ts";
import { applyWorkerDefinitionDefaults } from "../../core/src/domain/worker-definition-resolution.ts";
import type { WorkerDefinition } from "../../contracts/src/worker-definition.ts";
import { SqlBackedBackendResolver } from "../../core/src/services/SqlBackedBackendResolver.ts";
import type { BackendDefaults, ResolvedBackend } from "../../core/src/ports/BackendDefaults.ts";
import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type { WorkerRow } from "../../contracts/src/worker.ts";

// ─── Real DPI assembly, mirroring container.assembleAppendFor for one lane ──────
// container.assembleAppendFor is a thin closure: assemble the DPI text (with the
// lane base fragment in `extra` for "in-process", plus the worker-def body as a
// role/20 synthetic fragment), then fold in selectInjectableMemory(snapshot, lane).
// This reproduces that exact glue over the REAL prompt registry + REAL fragments so
// the assertions exercise the actual prompts and base-fragment file, not a stub.

const noopLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } } as never;
const promptsDir = join(import.meta.dirname, "..", "prompts");

function deps() {
  const registry = new PromptRegistry(new FilePromptSource([promptsDir]), noopLogger);
  return { registry, prompts: new PromptService(registry, TOOL_NAME_VARS) };
}

const BASE_MARKER = "reached directly over a model provider's API";
const DEF_BODY = "MARKER_WORKER_BODY — investigate the failing test and report findings.";
const MEMORY_MARKER = "MARKER_PROJECT_MEMORY_CLAUDEMD";

// A CLAUDE.md memory doc, native to the claude lanes only (matches real config).
const claudeMemory: MemoryDoc = {
  sourceId: "claude", sourceLabel: "CLAUDE.md", nativeFor: ["claude-cli", "claude-sdk"],
  path: "/repo/CLAUDE.md", level: "project", content: MEMORY_MARKER,
};

const baseCtx: SessionSpawnContext = {
  role: "worker", parentId: "orch", name: "demo", workerId: "w-1", model: "glm-5.2", effort: null,
  permissionMode: "acceptEdits", cwd: "/repo", worktreeDir: null, branch: null, repoRoot: null,
  isAttached: false, hasMcp: false, canCollaborate: false, workerDefinition: "general-purpose",
  workerDefinitionCatalog: "",
};

function assembleLike(lane: string): string | null {
  const d = deps();
  const extra: Fragment[] = [];
  if (lane === "in-process" && d.registry.has("lane/in-process")) {
    extra.push({ prompt: d.registry.get("lane/in-process"), dpi: { layer: "core", priority: -100 } });
  }
  const raw: RawPrompt = { id: "definition/general-purpose", frontmatter: { dpi: { layer: "role", priority: 20 }, variables: [] }, body: DEF_BODY };
  const frag = toFragment(parsePrompt(raw));
  if (frag) extra.push(frag);
  const { text } = assembleSystemPrompt(d, baseCtx, extra);
  const dpi = text.trim() ? text : null;
  return composeAppendedPrompt(dpi, selectInjectableMemory({ docs: [claudeMemory] }, lane));
}

// ─── B1 + N1: the in-process system prompt is complete and parity-equivalent ────

describe("B1/N1 — in-process lane system prompt (DPI delivery)", () => {
  it("delivers a non-empty system with protocol + worker-def body + injected memory + base harness", () => {
    const sys = assembleLike("in-process");
    assert.ok(sys && sys.trim().length > 0, "system is non-empty");
    assert.ok(sys!.includes(BASE_MARKER), "carries the lane base harness (N1)");
    assert.ok(sys!.includes(DEF_BODY), "carries the worker-definition body");
    assert.ok(sys!.includes(MEMORY_MARKER), "injects ALL memory (in-process is native to nothing)");
    assert.match(sys!, /send_message_to_parent/, "carries the Eos worker reporting protocol");
  });

  it("shares the SAME DPI core as the claude-sdk lane (same agent), adding only the base harness + all memory", () => {
    const inproc = assembleLike("in-process")!;
    const sdk = assembleLike("claude-sdk")!;
    // Same agent: both carry the worker protocol + the definition body byte-for-byte.
    assert.ok(inproc.includes(DEF_BODY) && sdk.includes(DEF_BODY), "both carry the definition body");
    assert.match(sdk, /send_message_to_parent/, "sdk lane carries the worker protocol too");
    // Lane-specific deltas: the base harness + CLAUDE.md memory are injected for the
    // binary-less in-process lane, but NOT the sdk lane (which has the preset + loads
    // CLAUDE.md natively).
    assert.ok(inproc.includes(BASE_MARKER) && !sdk.includes(BASE_MARKER), "base harness is in-process only");
    assert.ok(inproc.includes(MEMORY_MARKER) && !sdk.includes(MEMORY_MARKER), "CLAUDE.md injected for in-process, dropped for sdk (native)");
  });

  it("claude-cli lane also drops its native CLAUDE.md (regression guard on lane keying)", () => {
    assert.ok(!assembleLike("claude-cli")!.includes(MEMORY_MARKER));
  });
});

// ─── Behavioral parity + per-worker baseUrl/auth threading via the env factory ──

function fakeModel(turns: ModelTurn[]): ModelClient {
  let i = 0;
  return { async createTurn() { return turns[Math.min(i++, turns.length - 1)]; } };
}
const allowGate: ToolGate = { async decide() { return { allow: true }; } };

const tag = (e: AgentEvent): string =>
  e.type === "turn" ? `turn:${e.phase}`
    : e.type === "session" ? `session:${e.phase}`
    : e.type === "message" ? `msg:${e.blocks[0].type}`
    : e.type;

function laneSpec(): AgentLaunchSpec {
  return {
    workerId: "w-1", cwd: "/repo", model: "glm-5.2", prompt: "do it", persistent: false,
    parentId: "orch", isOrchestrator: false,
    backendOptions: {
      auth: { kind: "keychain", ref: "eos-glm" },
      baseUrl: "http://localhost:11434",
      capabilities: { wire: "openai-chat", supportsStreaming: true, supportsTools: true, supportsParallelToolCalls: true, reasoning: "none", reasoningRoundTrip: "drop", cache: "automatic", structuredOutput: "none", contextWindow: 32768 },
    },
  };
}

describe("B1 — async env factory threads per-worker creds/baseUrl/system into the model client", () => {
  it("resolves the worker's auth ref + baseUrl, builds the model from RESOLVED creds, and delivers the system prompt", async () => {
    const captured: { auth?: unknown; system?: string; apiKey?: string; baseUrl?: string; caps?: unknown } = {};
    const calls: unknown[] = [];
    const events: AgentEvent[] = [];
    const turns: ModelTurn[] = [
      { toolCalls: [{ callId: "c1", name: "echo", input: { v: 1 } }], stopReason: "tool_use" },
      { text: "all done", toolCalls: [], stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } },
    ];
    const factory = createInProcessEnvFactory({
      assembleSystem: () => assembleLike("in-process"),
      buildLaneTooling: () => ({
        items: [{ name: "echo", description: "e", schema: { type: "object" } }],
        tools: new Map<string, RuntimeTool>([["echo", { name: "echo", async execute(input) { calls.push(input); return "echoed"; } }]]),
      }),
      authResolver: { async resolve(auth) { captured.auth = auth; return { scheme: "apikey", apiKey: "resolved-key" }; } } as AuthResolver,
      makeGate: () => allowGate,
      buildModelClient: (input) => {
        captured.system = input.system; captured.apiKey = input.apiKey; captured.baseUrl = input.baseUrl; captured.caps = input.capabilities;
        return fakeModel(turns);
      },
    });
    const be = createInProcessBackend("anthropic-api", factory);
    const session = await be.start(laneSpec(), { onEvent: (e) => events.push(e) });
    await be.whenSettled("w-1");

    // Per-worker threading: the factory resolved THIS worker's auth ref (not env) and
    // built the client against THIS worker's baseUrl from the resolved key.
    assert.deepEqual(captured.auth, { kind: "keychain", ref: "eos-glm" });
    assert.equal(captured.apiKey, "resolved-key");
    assert.equal(captured.baseUrl, "http://localhost:11434");
    assert.equal((captured.caps as { contextWindow?: number }).contextWindow, 32768);
    // B1: the model received the complete system prompt (not empty).
    assert.ok(captured.system && captured.system.includes(BASE_MARKER) && captured.system.includes(DEF_BODY));

    // Behavioral parity: given a tool call, the API-lane worker USES the tool and
    // reaches the canonical observable outcome (same event sequence the seam proves
    // for every lane) — it does not "ignore its tools".
    assert.ok(session.isAlive());
    assert.deepEqual(calls, [{ v: 1 }], "the tool actually executed");
    assert.deepEqual(events.map(tag), [
      "session:started", "turn:started", "msg:tool_call", "msg:tool_result", "msg:text", "usage", "context", "turn:ended",
    ]);
  });

  it("keyless localhost (auth none) yields an empty apiKey to the client", async () => {
    const captured: { apiKey?: string } = {};
    const factory = createInProcessEnvFactory({
      assembleSystem: () => "system",
      buildLaneTooling: () => ({ items: [], tools: new Map() }),
      authResolver: { async resolve() { return { scheme: "none" }; } } as AuthResolver,
      makeGate: () => allowGate,
      buildModelClient: (input) => { captured.apiKey = input.apiKey; return fakeModel([{ text: "ok", toolCalls: [], stopReason: "end_turn" }]); },
    });
    const be = createInProcessBackend("openai", factory);
    await be.start({ ...laneSpec(), backendOptions: { auth: { kind: "none" }, baseUrl: "http://localhost:11434" } }, {});
    await be.whenSettled("w-1");
    assert.equal(captured.apiKey, "");
  });

  it("fail-fast context-window guard fires (typed error) before a too-small-context model call", async () => {
    const events: AgentEvent[] = [];
    let modelCalled = false;
    const factory = createInProcessEnvFactory({
      assembleSystem: () => "system",
      buildLaneTooling: () => ({ items: [], tools: new Map() }),
      authResolver: { async resolve() { return { scheme: "none" }; } } as AuthResolver,
      makeGate: () => allowGate,
      // contextWindow:1 → any prompt overflows the 0.9× high-water mark.
      buildModelClient: () => ({ async createTurn() { modelCalled = true; return { text: "x", toolCalls: [], stopReason: "end_turn" }; } }),
    });
    const spec = { ...laneSpec(), backendOptions: { auth: { kind: "none" as const }, capabilities: { wire: "openai-chat" as const, supportsStreaming: true, supportsTools: true, supportsParallelToolCalls: true, reasoning: "none" as const, reasoningRoundTrip: "drop" as const, cache: "automatic" as const, structuredOutput: "none" as const, contextWindow: 1 } } };
    const be = createInProcessBackend("openai", factory);
    await be.start(spec, { onEvent: (e) => events.push(e) });
    await be.whenSettled("w-1");
    assert.equal(modelCalled, false, "the model was never called");
    assert.ok(events.some((e) => e.type === "turn" && e.phase === "error" && e.reason === "context_window_exceeded"));
  });
});

// ─── POST /api/backends validation: baseUrl normalize (MJ1) + billed-needs-price (MJ2) ──

const PRICES: Record<string, ModelPrice> = {
  opus: { in: 15, out: 75, cacheRead: 1.5, cacheCreate: 18.75, cacheCreate1h: 30 },
};
function addReq(over: Partial<AddBackendRequest>): AddBackendRequest {
  return { name: "p", kind: "openai", model: "deepseek-chat", ...over } as AddBackendRequest;
}

describe("POST /api/backends — validateAddBackend", () => {
  it("normalizes baseUrl to origin-only (strips a trailing /v1)", () => {
    const r = validateAddBackend(addReq({ baseUrl: "http://localhost:11434/v1", auth: { kind: "none" } }), PRICES);
    assert.ok(r.ok);
    assert.equal(r.ok && r.prepared.profile.baseUrl, "http://localhost:11434");
  });

  it("rejects a costMode:billed profile whose model has no price (MJ2)", () => {
    const r = validateAddBackend(addReq({ costMode: "billed", auth: { kind: "none" } }), PRICES);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /no price/);
  });

  it("accepts a billed profile when an inline price is supplied", () => {
    const r = validateAddBackend(addReq({ costMode: "billed", auth: { kind: "none" }, price: { in: 0.5, out: 1.5, cacheRead: 0.05, cacheCreate: 0.6 } }), PRICES);
    assert.ok(r.ok);
    assert.equal(r.ok && r.prepared.priceKey, "deepseek-chat");
  });

  it("accepts a billed Claude-model profile without an inline price (substring-priced)", () => {
    const r = validateAddBackend(addReq({ model: "claude-opus-4-8", kind: "anthropic-api", costMode: "billed", auth: { kind: "keychain", ref: "eos-anthropic" }, apiKey: "sk-x" }), PRICES);
    assert.ok(r.ok);
  });

  it("requires apiKey for a keychain credential", () => {
    const r = validateAddBackend(addReq({ auth: { kind: "keychain", ref: "eos-x" } }), PRICES);
    assert.equal(r.ok, false);
  });
});

// ─── Multi-scope backendProfile: definition default → resolver, + inheritance ───

const RESOLVED: Record<string, ResolvedBackend> = {
  "glm-local": { kind: "openai", model: "glm-5.2", profileName: "glm-local", costMode: "billed", baseUrl: "http://localhost:11434", auth: { kind: "none" } },
};
function backendDefaults(): BackendDefaults {
  return { profile: (n) => RESOLVED[n] ?? null, roleDefaultName: () => null };
}
function workerRepo(rows: Record<string, Partial<WorkerRow>>): WorkerRepo {
  return { findById: (id: string) => (rows[id] ?? null) as WorkerRow | null } as unknown as WorkerRepo;
}

describe("multi-scope backendProfile — definition default flows to the resolver, inheritance holds", () => {
  it("applyWorkerDefinitionDefaults carries backendProfile when the request left it unset", () => {
    const def = { backendProfile: "glm-local" } as WorkerDefinition;
    assert.equal(applyWorkerDefinitionDefaults(def, () => false).backendProfile, "glm-local");
  });

  it("an explicit request value wins over the definition default (requestHas guard)", () => {
    const def = { backendProfile: "glm-local" } as WorkerDefinition;
    assert.equal(applyWorkerDefinitionDefaults(def, (f) => f === "backendProfile").backendProfile, undefined);
  });

  it("the resolver honors a definition's backendProfile as explicitProfileName (any scope)", () => {
    const r = new SqlBackedBackendResolver(workerRepo({}), backendDefaults());
    const out = r.resolveForNewWorker({ explicitProfileName: "glm-local", isOrchestrator: false });
    assert.equal(out.kind, "openai");
    assert.equal(out.profileName, "glm-local");
    assert.deepEqual(out.auth, { kind: "none" }); // auth threaded through profile()
  });

  it("a child with no profile inherits the parent's backendProfile", () => {
    const r = new SqlBackedBackendResolver(
      workerRepo({ orch: { backend_profile: "glm-local", parent_id: null } }),
      backendDefaults(),
    );
    const out = r.resolveForNewWorker({ parentId: "orch", isOrchestrator: false });
    assert.equal(out.profileName, "glm-local");
    assert.equal(out.kind, "openai");
  });
});
