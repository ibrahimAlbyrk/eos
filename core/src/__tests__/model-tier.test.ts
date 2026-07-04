import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_IDENTITY,
  resolveTier,
  isClaudeIdentity,
  type ProviderIdentity,
} from "../domain/model-tier.ts";

const DEEPSEEK: ProviderIdentity = {
  persona: "DeepSeek",
  tiers: { high: "deepseek-v4-pro", medium: "deepseek-v4-pro", low: "deepseek-v4-flash" },
  effortSupported: false,
};

// A collapsed identity — fewer real models than tiers, so ids repeat.
const KIMI: ProviderIdentity = {
  persona: "Kimi",
  tiers: { high: "kimi-k2.6", medium: "kimi-k2.6", low: "kimi-k2.5" },
  effortSupported: false,
};

describe("resolveTier — tier name → the identity's model", () => {
  it("maps high/medium/low on Claude", () => {
    assert.equal(resolveTier("high", CLAUDE_IDENTITY), "opus");
    assert.equal(resolveTier("medium", CLAUDE_IDENTITY), "sonnet");
    assert.equal(resolveTier("low", CLAUDE_IDENTITY), "haiku");
  });

  it("maps tiers on a non-Claude identity", () => {
    assert.equal(resolveTier("high", DEEPSEEK), "deepseek-v4-pro");
    assert.equal(resolveTier("low", DEEPSEEK), "deepseek-v4-flash");
  });

  it("resolves same-id collapse without error", () => {
    assert.equal(resolveTier("high", KIMI), "kimi-k2.6");
    assert.equal(resolveTier("medium", KIMI), "kimi-k2.6");
    assert.equal(resolveTier("low", KIMI), "kimi-k2.5");
  });
});

describe("resolveTier — legacy alias fallback fires ONLY for non-Claude", () => {
  it("maps a Claude alias to the provider's tier on a non-Claude identity", () => {
    assert.equal(resolveTier("opus", DEEPSEEK), "deepseek-v4-pro"); // high
    assert.equal(resolveTier("sonnet", DEEPSEEK), "deepseek-v4-pro"); // medium
    assert.equal(resolveTier("haiku", DEEPSEEK), "deepseek-v4-flash"); // low
    assert.equal(resolveTier("fable", DEEPSEEK), "deepseek-v4-pro"); // high
  });

  it("passes Claude aliases through unchanged on the Claude identity", () => {
    assert.equal(resolveTier("opus", CLAUDE_IDENTITY), "opus");
    assert.equal(resolveTier("sonnet", CLAUDE_IDENTITY), "sonnet");
    assert.equal(resolveTier("haiku", CLAUDE_IDENTITY), "haiku");
    assert.equal(resolveTier("fable", CLAUDE_IDENTITY), "fable");
  });
});

describe("resolveTier — concrete ids pass through", () => {
  it("leaves a concrete id untouched on both identity kinds", () => {
    assert.equal(resolveTier("opus-4.8", CLAUDE_IDENTITY), "opus-4.8");
    assert.equal(resolveTier("deepseek-v4-pro", DEEPSEEK), "deepseek-v4-pro");
    assert.equal(resolveTier("gpt-5.5", DEEPSEEK), "gpt-5.5");
  });
});

describe("isClaudeIdentity", () => {
  it("is true for the Claude identity, false for others", () => {
    assert.equal(isClaudeIdentity(CLAUDE_IDENTITY), true);
    assert.equal(isClaudeIdentity(DEEPSEEK), false);
  });
});
