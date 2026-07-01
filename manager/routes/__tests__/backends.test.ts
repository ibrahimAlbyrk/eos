import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchBackendModels, validateAddBackend } from "../backends.ts";
import { findPreset } from "../../shared/provider-presets.ts";
import type { AgentCapabilities, BackendDescriptor } from "../../../core/src/ports/AgentBackend.ts";
import type { ResolvedAuth } from "../../../core/src/ports/AuthResolver.ts";
import type { BackendProfile } from "../../../contracts/src/backend.ts";
import type { AddBackendRequest } from "../../../contracts/src/http.ts";

const caps: AgentCapabilities = { interrupt: true, keystroke: false, rewind: false, runtimeModelSwitch: false, runtimePermissionSwitch: false };

// Mirrors the real openai + claude-sdk descriptors (modelSource + wireDialect are
// the DATA the endpoint branches on — never a kind literal).
const openaiDescriptor: BackendDescriptor = {
  kind: "openai", label: "OpenAI API", processModel: "in-process", billing: "metered",
  modelSource: "profile", capabilities: caps, models: { kind: "openai-compatible" },
  auth: "apikey", enabled: true, sessionStore: "eos-conversation", wireDialect: "openai-chat",
};
const claudeSdkDescriptor: BackendDescriptor = {
  kind: "claude-sdk", label: "Claude SDK", processModel: "in-process", billing: "subscription",
  modelSource: "request", capabilities: caps, models: { kind: "claude" },
  auth: "subscription", enabled: true, sessionStore: "claude-transcript",
};

const deepseekProfile: BackendProfile = {
  kind: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com",
  auth: { kind: "keychain", ref: "eos-deepseek" }, costMode: "billed",
};

const apiKeyAuth = async (): Promise<ResolvedAuth> => ({ scheme: "apikey", apiKey: "KEY" });
const fakeFetch = (impl: (url: string, init?: { headers?: Record<string, string> }) => unknown): typeof fetch =>
  (impl as unknown as typeof fetch);

describe("fetchBackendModels", () => {
  it("fetches the provider /v1/models with a Bearer header and returns all ids", async () => {
    let seenUrl = ""; let seenAuth = "";
    const res = await fetchBackendModels({
      profile: deepseekProfile,
      descriptor: openaiDescriptor,
      claudeCatalogIds: async () => { throw new Error("must not hit the Claude catalog"); },
      resolveAuth: apiKeyAuth,
      fetchImpl: fakeFetch((url, init) => {
        seenUrl = url; seenAuth = init?.headers?.authorization ?? "";
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) };
      }),
    });
    assert.equal(seenUrl, "https://api.deepseek.com/v1/models");
    assert.equal(seenAuth, "Bearer KEY");
    assert.deepEqual(res.models, ["deepseek-chat", "deepseek-reasoner"]);
    assert.equal(res.error, undefined);
  });

  it("FAIL-SOFT: a thrown fetch returns the pinned model alone + an error", async () => {
    const res = await fetchBackendModels({
      profile: deepseekProfile,
      descriptor: openaiDescriptor,
      claudeCatalogIds: async () => [],
      resolveAuth: apiKeyAuth,
      fetchImpl: fakeFetch(() => { throw new Error("network down"); }),
    });
    assert.deepEqual(res.models, ["deepseek-chat"]);
    assert.equal(res.error, "network down");
  });

  it("FAIL-SOFT: a non-ok response returns the pinned model + an HTTP error", async () => {
    const res = await fetchBackendModels({
      profile: deepseekProfile,
      descriptor: openaiDescriptor,
      claudeCatalogIds: async () => [],
      resolveAuth: async () => ({ scheme: "none" }),
      fetchImpl: fakeFetch(() => ({ ok: false, status: 401, json: async () => ({}) })),
    });
    assert.deepEqual(res.models, ["deepseek-chat"]);
    assert.match(res.error ?? "", /HTTP 401/);
  });

  it("annotates each model with a price: provider-endpoint pricing preferred, else the catalog", async () => {
    const catalog: Record<string, { in: number; out: number; cacheRead: number; cacheCreate: number; cacheCreate1h: number }> = {
      "deepseek-chat": { in: 0.28, out: 0.42, cacheRead: 0.028, cacheCreate: 0, cacheCreate1h: 0 },
    };
    const res = await fetchBackendModels({
      profile: deepseekProfile,
      descriptor: openaiDescriptor,
      claudeCatalogIds: async () => [],
      resolveAuth: apiKeyAuth,
      priceFor: (m) => catalog[m] ?? null,
      fetchImpl: fakeFetch(() => ({
        ok: true, status: 200, json: async () => ({
          data: [
            // OpenRouter-style per-TOKEN pricing on the row → preferred over the catalog
            { id: "router-model", pricing: { prompt: "0.000001", completion: "0.000002" } },
            // no row pricing → falls back to the catalog
            { id: "deepseek-chat" },
            // unknown to both → no price annotation, still listed
            { id: "mystery-model" },
          ],
        }),
      })),
    });
    assert.deepEqual(res.models, ["router-model", "deepseek-chat", "mystery-model"]);
    assert.deepEqual(res.prices?.["router-model"], { in: 1, out: 2 });
    assert.deepEqual(res.prices?.["deepseek-chat"], { in: 0.28, out: 0.42 });
    assert.equal(res.prices?.["mystery-model"], undefined);
  });

  it("omits the prices map entirely when nothing resolves a price", async () => {
    const res = await fetchBackendModels({
      profile: deepseekProfile,
      descriptor: openaiDescriptor,
      claudeCatalogIds: async () => [],
      resolveAuth: apiKeyAuth,
      fetchImpl: fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ data: [{ id: "deepseek-chat" }] }) })),
    });
    assert.deepEqual(res.models, ["deepseek-chat"]);
    assert.equal(res.prices, undefined);
  });

  it("subscription (request-model) profile returns the Claude catalog ids without a provider call", async () => {
    const claudeSdkProfile: BackendProfile = { kind: "claude-sdk", model: "opus", auth: { kind: "subscription" }, costMode: "included" };
    const res = await fetchBackendModels({
      profile: claudeSdkProfile,
      descriptor: claudeSdkDescriptor,
      claudeCatalogIds: async () => ["opus", "sonnet", "haiku"],
      resolveAuth: async () => { throw new Error("must not resolve auth for a subscription lane"); },
      fetchImpl: fakeFetch(() => { throw new Error("must not fetch for a subscription lane"); }),
    });
    assert.deepEqual(res.models, ["opus", "sonnet", "haiku"]);
    assert.equal(res.error, undefined);
  });
});

describe("fetchBackendModels — preset providers (path, auth, fallback)", () => {
  const zhipuProfile: BackendProfile = {
    kind: "openai", model: "glm-5.2", baseUrl: "https://api.z.ai",
    auth: { kind: "keychain", ref: "eos-zhipu" }, costMode: "billed",
    capabilities: findPreset("zhipu")!.capabilities,
  };
  const geminiProfile: BackendProfile = {
    kind: "openai", model: "gemini-3.1-pro-preview", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    auth: { kind: "keychain", ref: "eos-gemini" }, costMode: "billed",
    capabilities: findPreset("gemini")!.capabilities,
  };

  it("derives the models path from chatCompletionsPath (Zhipu → /api/paas/v4/models)", async () => {
    let seenUrl = "";
    await fetchBackendModels({
      profile: zhipuProfile, descriptor: openaiDescriptor, claudeCatalogIds: async () => [], resolveAuth: apiKeyAuth,
      fetchImpl: fakeFetch((url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ data: [{ id: "glm-5.2" }] }) }; }),
    });
    assert.equal(seenUrl, "https://api.z.ai/api/paas/v4/models");
  });

  it("Gemini sends x-goog-api-key (no Authorization) and hits .../openai/models", async () => {
    let seenUrl = ""; let seenHeaders: Record<string, string> = {};
    await fetchBackendModels({
      profile: geminiProfile, descriptor: openaiDescriptor, claudeCatalogIds: async () => [], resolveAuth: apiKeyAuth,
      fetchImpl: fakeFetch((url, init) => { seenUrl = url; seenHeaders = init?.headers ?? {}; return { ok: true, status: 200, json: async () => ({ data: [{ id: "gemini-3.1-pro-preview" }] }) }; }),
    });
    assert.equal(seenUrl, "https://generativelanguage.googleapis.com/v1beta/openai/models");
    assert.equal(seenHeaders["x-goog-api-key"], "KEY");
    assert.equal(seenHeaders.authorization, undefined);
  });

  it("FAIL-SOFT returns the provider's static fallback list (pinned model first), never empty", async () => {
    const res = await fetchBackendModels({
      profile: zhipuProfile, descriptor: openaiDescriptor, claudeCatalogIds: async () => [], resolveAuth: apiKeyAuth,
      fetchImpl: fakeFetch(() => { throw new Error("down"); }),
    });
    assert.deepEqual(res.models, ["glm-5.2", "glm-4.7", "glm-4.7-flash"]);
    assert.equal(res.error, "down");
  });
});

describe("validateAddBackend — preset expansion", () => {
  it("a preset fills kind/model/baseUrl/capabilities/auth so only the key is needed", () => {
    const gemini = findPreset("gemini")!;
    const req: AddBackendRequest = { name: "gemini", preset: "gemini", apiKey: "AIza-x" };
    const r = validateAddBackend(req, {}, undefined, gemini);
    assert.ok(r.ok);
    const p = r.prepared.profile;
    assert.equal(p.kind, "openai");
    assert.equal(p.model, "gemini-3.1-pro-preview");
    assert.equal(p.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
    assert.equal(p.costMode, "billed");
    assert.equal(p.capabilities?.authStyle, "x-goog-api-key");
    assert.equal(p.auth?.kind, "keychain");
    assert.equal(p.auth?.ref, "eos-gemini");
  });

  it("explicit body fields override the preset", () => {
    const openai = findPreset("openai")!;
    const req: AddBackendRequest = { name: "oai", preset: "openai", model: "gpt-5.4-mini", apiKey: "sk" };
    const r = validateAddBackend(req, {}, undefined, openai);
    assert.ok(r.ok);
    assert.equal(r.prepared.profile.model, "gpt-5.4-mini");
  });

  it("rejects a request with neither kind nor a preset", () => {
    const r = validateAddBackend({ name: "x" } as AddBackendRequest, {});
    assert.equal(r.ok, false);
  });
});
