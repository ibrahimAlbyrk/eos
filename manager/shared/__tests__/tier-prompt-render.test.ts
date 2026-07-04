import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderModelTierTable, renderEffortSection, defaultEffortFor } from "../tier-prompt-render.ts";
import { CLAUDE_IDENTITY, type ProviderIdentity } from "../../../core/src/domain/model-tier.ts";

const DEEPSEEK: ProviderIdentity = {
  persona: "DeepSeek",
  tiers: { high: "deepseek-v4-pro", medium: "deepseek-v4-pro", low: "deepseek-v4-flash" },
  effortSupported: false,
};

describe("renderModelTierTable", () => {
  it("emits a tier|model|use-for row per tier with the identity's own models", () => {
    const table = renderModelTierTable(DEEPSEEK);
    assert.match(table, /\| high \| deepseek-v4-pro \|/);
    assert.match(table, /\| medium \| deepseek-v4-pro \|/);
    assert.match(table, /\| low \| deepseek-v4-flash \|/);
    assert.match(table, /\| tier \| model \| use for \|/);
  });

  it("uses Claude's aliases on the Claude identity", () => {
    const table = renderModelTierTable(CLAUDE_IDENTITY);
    assert.match(table, /\| high \| opus \|/);
    assert.match(table, /\| medium \| sonnet \|/);
    assert.match(table, /\| low \| haiku \|/);
  });
});

describe("renderEffortSection — gated both ways", () => {
  it("renders the full effort table when the provider supports effort", () => {
    const section = renderEffortSection(CLAUDE_IDENTITY);
    assert.match(section, /\| effort \| use for \|/);
    assert.match(section, /xhigh \(default\)/);
  });

  it("renders the omit-effort one-liner when the provider has no lever", () => {
    const section = renderEffortSection(DEEPSEEK);
    assert.doesNotMatch(section, /\| effort \|/);
    assert.match(section, /no reasoning-effort lever/);
  });
});

describe("defaultEffortFor", () => {
  it("is xhigh for Claude, high otherwise", () => {
    assert.equal(defaultEffortFor(CLAUDE_IDENTITY), "xhigh");
    assert.equal(defaultEffortFor(DEEPSEEK), "high");
  });
});
