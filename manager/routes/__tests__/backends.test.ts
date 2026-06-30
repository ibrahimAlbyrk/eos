import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchBackendModels } from "../backends.ts";
import type { AgentCapabilities, BackendDescriptor } from "../../../core/src/ports/AgentBackend.ts";
import type { ResolvedAuth } from "../../../core/src/ports/AuthResolver.ts";
import type { BackendProfile } from "../../../contracts/src/backend.ts";

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
