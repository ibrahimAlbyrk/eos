import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, findPreset, fallbackModelsForBaseUrl } from "../provider-presets.ts";

describe("provider presets", () => {
  it("ships exactly the seven providers, all OpenAI-compat, each with a fallback list", () => {
    assert.deepEqual(
      PROVIDER_PRESETS.map((p) => p.id).sort(),
      ["deepseek", "gemini", "moonshot", "openai", "qwen", "xai", "zhipu"],
    );
    for (const p of PROVIDER_PRESETS) {
      assert.equal(p.kind, "openai", `${p.id} kind`);
      assert.equal(p.capabilities.wire, "openai-chat", `${p.id} wire`);
      assert.ok(p.fallbackModels.length > 0, `${p.id} has a fallback list`);
      assert.ok(p.fallbackModels.includes(p.defaultModel), `${p.id} default model is in its fallback list`);
      assert.ok(p.authRef.startsWith("eos-"), `${p.id} authRef`);
    }
  });

  it("Gemini uses the shim base, Bearer auth (default), and a /chat/completions path", () => {
    const g = findPreset("gemini")!;
    assert.equal(g.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
    // The OpenAI-compat shim authenticates with Authorization: Bearer — the omitted
    // default — NOT x-goog-api-key (which is native-REST-only).
    assert.equal(g.capabilities.authStyle, undefined);
    assert.equal(g.capabilities.chatCompletionsPath, "/chat/completions");
  });

  it("OpenAI declares gpt-5.x quirks: max_completion_tokens + reasoning_effort suppressed with tools", () => {
    const o = findPreset("openai")!;
    assert.equal(o.capabilities.maxTokensParam, "max_completion_tokens");
    assert.equal(o.capabilities.dropReasoningEffortWithTools, true);
    // Every other preset stays on the safe defaults.
    for (const p of PROVIDER_PRESETS.filter((p) => p.id !== "openai")) {
      assert.equal(p.capabilities.maxTokensParam, "max_tokens", `${p.id} maxTokensParam default`);
      assert.equal(p.capabilities.dropReasoningEffortWithTools, false, `${p.id} dropReasoningEffortWithTools default`);
    }
  });

  it("Zhipu declares the /api/paas/v4 chat path off a bare origin", () => {
    const z = findPreset("zhipu")!;
    assert.equal(z.baseUrl, "https://api.z.ai");
    assert.equal(z.capabilities.chatCompletionsPath, "/api/paas/v4/chat/completions");
  });

  it("DeepSeek uses the default /v1 path, reasoning_content (dropped), 1M context", () => {
    const d = findPreset("deepseek")!;
    assert.equal(d.baseUrl, "https://api.deepseek.com");
    assert.equal(d.defaultModel, "deepseek-v4-flash");
    // DeepSeek accepts /v1/chat/completions, so no chatCompletionsPath override.
    assert.equal(d.capabilities.chatCompletionsPath, undefined);
    assert.equal(d.capabilities.reasoning, "reasoning_content");
    assert.equal(d.capabilities.reasoningRoundTrip, "drop");
    assert.equal(d.capabilities.contextWindow, 1_000_000);
    assert.deepEqual(d.fallbackModels, ["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("fallbackModelsForBaseUrl matches by normalized origin, null for unknown", () => {
    assert.deepEqual(fallbackModelsForBaseUrl("https://api.x.ai/v1"), findPreset("xai")!.fallbackModels);
    assert.deepEqual(fallbackModelsForBaseUrl("https://api.openai.com/"), findPreset("openai")!.fallbackModels);
    assert.deepEqual(fallbackModelsForBaseUrl("https://api.deepseek.com"), findPreset("deepseek")!.fallbackModels);
    assert.equal(fallbackModelsForBaseUrl(undefined), null);
  });
});
