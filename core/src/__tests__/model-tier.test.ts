import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_IDENTITY,
  resolveTier,
  isClaudeIdentity,
  tierNames,
  defaultTierName,
  defaultTierIsValid,
  hasTier,
  type ProviderIdentity,
} from "../domain/model-tier.ts";

const DEEPSEEK: ProviderIdentity = {
  persona: "DeepSeek",
  tiers: [
    { name: "high", model: "deepseek-v4-pro" },
    { name: "medium", model: "deepseek-v4-pro" },
    { name: "low", model: "deepseek-v4-flash" },
  ],
  effortSupported: false,
};

// A collapsed identity — fewer real models than tiers, so ids repeat.
const KIMI: ProviderIdentity = {
  persona: "Kimi",
  tiers: [
    { name: "high", model: "kimi-k2.6" },
    { name: "medium", model: "kimi-k2.6" },
    { name: "low", model: "kimi-k2.5" },
  ],
  effortSupported: false,
};

// A 2-tier vocabulary (strongest-first) — the default tier is "medium", "high" is absent.
const TWO_TIER: ProviderIdentity = {
  persona: "TwoTier",
  tiers: [
    { name: "medium", model: "m-pro" },
    { name: "low", model: "m-flash" },
  ],
  effortSupported: false,
};

// A 5-tier vocabulary (strongest-first) with tiers beyond the baseline triple.
const FIVE_TIER: ProviderIdentity = {
  persona: "FiveTier",
  tiers: [
    { name: "ultra", model: "u" },
    { name: "max", model: "x" },
    { name: "high", model: "h" },
    { name: "medium", model: "md" },
    { name: "low", model: "l" },
  ],
  effortSupported: false,
};

// A fully custom-named vocabulary (no baseline names at all) — an alias has no rank
// anchor, so it clamps to the default (strongest) tier.
const CUSTOM: ProviderIdentity = {
  persona: "Custom",
  tiers: [
    { name: "alpha", model: "a" },
    { name: "beta", model: "b" },
  ],
  effortSupported: false,
};

describe("resolveTier — tier name → the identity's model", () => {
  it("maps max/high/medium/low on Claude", () => {
    assert.equal(resolveTier("max", CLAUDE_IDENTITY), "fable");
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

describe("resolveTier — variable-length vocabularies", () => {
  it("resolves every tier of a 5-tier vocabulary", () => {
    assert.equal(resolveTier("ultra", FIVE_TIER), "u");
    assert.equal(resolveTier("max", FIVE_TIER), "x");
    assert.equal(resolveTier("high", FIVE_TIER), "h");
    assert.equal(resolveTier("medium", FIVE_TIER), "md");
    assert.equal(resolveTier("low", FIVE_TIER), "l");
  });

  it("resolves both tiers of a 2-tier vocabulary", () => {
    assert.equal(resolveTier("medium", TWO_TIER), "m-pro");
    assert.equal(resolveTier("low", TWO_TIER), "m-flash");
  });

  it("passes an undefined tier through untouched (resolveTier is total — the reject lives at the spawn chokepoint)", () => {
    assert.equal(resolveTier("high", TWO_TIER), "high"); // "high" not defined here
    assert.equal(resolveTier("mega", FIVE_TIER), "mega");
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

  it("clamps an alias to the nearest defined rank on a sparse provider", () => {
    // "high" is absent → opus/fable clamp to the strongest present tier (medium).
    assert.equal(resolveTier("opus", TWO_TIER), "m-pro");
    assert.equal(resolveTier("fable", TWO_TIER), "m-pro");
    // medium/low are present → exact.
    assert.equal(resolveTier("sonnet", TWO_TIER), "m-pro");
    assert.equal(resolveTier("haiku", TWO_TIER), "m-flash");
  });

  it("falls back to the default tier when the vocabulary defines no baseline name", () => {
    assert.equal(resolveTier("opus", CUSTOM), "a"); // tiers[0]
    assert.equal(resolveTier("haiku", CUSTOM), "a");
  });
});

describe("resolveTier — concrete ids pass through", () => {
  it("leaves a concrete id untouched on both identity kinds", () => {
    assert.equal(resolveTier("opus-4.8", CLAUDE_IDENTITY), "opus-4.8");
    assert.equal(resolveTier("deepseek-v4-pro", DEEPSEEK), "deepseek-v4-pro");
    assert.equal(resolveTier("gpt-5.5", DEEPSEEK), "gpt-5.5");
  });
});

describe("tier helpers", () => {
  it("tierNames lists the vocabulary in order (strongest-first)", () => {
    assert.deepEqual(tierNames(CLAUDE_IDENTITY), ["max", "high", "medium", "low"]);
    assert.deepEqual(tierNames(FIVE_TIER), ["ultra", "max", "high", "medium", "low"]);
    assert.deepEqual(tierNames(TWO_TIER), ["medium", "low"]);
  });

  it("defaultTierName is defaultTier when set, else the first (strongest) tier", () => {
    // Claude lists max=fable strongest-first but its default stays high (opus).
    assert.equal(defaultTierName(CLAUDE_IDENTITY), "high");
    assert.notEqual(defaultTierName(CLAUDE_IDENTITY), CLAUDE_IDENTITY.tiers[0].name);
    // Identities without defaultTier fall back to tiers[0].
    assert.equal(defaultTierName(FIVE_TIER), "ultra");
    assert.equal(defaultTierName(TWO_TIER), "medium");
  });

  it("hasTier is true only for defined names", () => {
    assert.equal(hasTier(CLAUDE_IDENTITY, "max"), true);
    assert.equal(hasTier(CLAUDE_IDENTITY, "high"), true);
    assert.equal(hasTier(TWO_TIER, "high"), false);
    assert.equal(hasTier(FIVE_TIER, "ultra"), true);
    assert.equal(hasTier(FIVE_TIER, "mega"), false);
  });
});

describe("defaultTier — decoupled from tiers[0]", () => {
  it("CLAUDE_IDENTITY defaults to high (opus), NOT its strongest tier max (fable)", () => {
    assert.equal(CLAUDE_IDENTITY.tiers[0].name, "max"); // strongest-first
    assert.equal(defaultTierName(CLAUDE_IDENTITY), "high"); // but default stays high
    assert.equal(resolveTier(defaultTierName(CLAUDE_IDENTITY), CLAUDE_IDENTITY), "opus");
  });

  it("an identity whose default is not tiers[0] resolves the chosen default", () => {
    const custom: ProviderIdentity = {
      persona: "Custom",
      tiers: [
        { name: "ultra", model: "u" },
        { name: "std", model: "s" },
      ],
      defaultTier: "std",
      effortSupported: false,
    };
    assert.equal(defaultTierName(custom), "std");
    assert.equal(resolveTier(defaultTierName(custom), custom), "s");
  });

  it("defaultTierIsValid: true when unset or naming a real tier, false otherwise", () => {
    assert.equal(defaultTierIsValid(CLAUDE_IDENTITY), true); // "high" exists
    assert.equal(defaultTierIsValid(FIVE_TIER), true); // unset ⇒ tiers[0]
    const bogus: ProviderIdentity = {
      persona: "Bogus",
      tiers: [{ name: "a", model: "x" }],
      defaultTier: "nope",
      effortSupported: false,
    };
    assert.equal(defaultTierIsValid(bogus), false);
  });
});

describe("isClaudeIdentity", () => {
  it("is true for the Claude identity, false for others", () => {
    assert.equal(isClaudeIdentity(CLAUDE_IDENTITY), true);
    assert.equal(isClaudeIdentity(DEEPSEEK), false);
  });
});
