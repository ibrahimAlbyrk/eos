import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProviderCapabilitiesSchema } from "../provider-capabilities.ts";

describe("ProviderCapabilitiesSchema — auth + path additions", () => {
  it("accepts authStyle x-goog-api-key and a custom chatCompletionsPath", () => {
    const caps = ProviderCapabilitiesSchema.parse({
      wire: "openai-chat",
      contextWindow: 1_000_000,
      authStyle: "x-goog-api-key",
      chatCompletionsPath: "/chat/completions",
    });
    assert.equal(caps.authStyle, "x-goog-api-key");
    assert.equal(caps.chatCompletionsPath, "/chat/completions");
  });

  it("leaves both undefined when omitted (bearer + /v1 are client defaults)", () => {
    const caps = ProviderCapabilitiesSchema.parse({ wire: "openai-chat", contextWindow: 8192 });
    assert.equal(caps.authStyle, undefined);
    assert.equal(caps.chatCompletionsPath, undefined);
  });

  it("rejects an unknown authStyle", () => {
    assert.throws(() => ProviderCapabilitiesSchema.parse({ wire: "openai-chat", contextWindow: 8192, authStyle: "header" }));
  });

  it("defaults maxTokensParam to max_tokens and dropReasoningEffortWithTools to false", () => {
    const caps = ProviderCapabilitiesSchema.parse({ wire: "openai-chat", contextWindow: 8192 });
    assert.equal(caps.maxTokensParam, "max_tokens");
    assert.equal(caps.dropReasoningEffortWithTools, false);
  });

  it("accepts max_completion_tokens + dropReasoningEffortWithTools (gpt-5.x)", () => {
    const caps = ProviderCapabilitiesSchema.parse({
      wire: "openai-chat", contextWindow: 1_050_000,
      maxTokensParam: "max_completion_tokens", dropReasoningEffortWithTools: true,
    });
    assert.equal(caps.maxTokensParam, "max_completion_tokens");
    assert.equal(caps.dropReasoningEffortWithTools, true);
  });

  it("rejects an unknown maxTokensParam", () => {
    assert.throws(() => ProviderCapabilitiesSchema.parse({ wire: "openai-chat", contextWindow: 8192, maxTokensParam: "max_output_tokens" }));
  });
});
