import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderModelTierTable, renderEffortSection, defaultEffortFor } from "../tier-prompt-render.ts";
import { CLAUDE_IDENTITY, type ProviderIdentity } from "../../../core/src/domain/model-tier.ts";

const DEEPSEEK: ProviderIdentity = {
  persona: "DeepSeek",
  tiers: [
    { name: "high", model: "deepseek-v4-pro" },
    { name: "medium", model: "deepseek-v4-pro" },
    { name: "low", model: "deepseek-v4-flash" },
  ],
  effortSupported: false,
};

// helper: count the data rows in a rendered table (drop the header + separator).
const rowCount = (table: string): number => table.split("\n").length - 2;

describe("renderModelTierTable", () => {
  it("emits a tier|model|use-for row per tier with the identity's own models (default row marked)", () => {
    const table = renderModelTierTable(DEEPSEEK);
    // No defaultTier ⇒ tiers[0] (high) is the default and carries the marker.
    assert.match(table, /\| high \(default\) \| deepseek-v4-pro \|/);
    assert.match(table, /\| medium \| deepseek-v4-pro \|/);
    assert.match(table, /\| low \| deepseek-v4-flash \|/);
    assert.match(table, /\| tier \| model \| use for \|/);
    assert.equal(rowCount(table), 3);
  });

  it("renders Claude's 4 tiers and marks high as the default (not the strongest max row)", () => {
    const table = renderModelTierTable(CLAUDE_IDENTITY);
    assert.equal(rowCount(table), 4);
    assert.match(table, /\| max \| fable \|/); // strongest, but NOT marked default
    assert.match(table, /\| high \(default\) \| opus \|/); // default is high, decoupled from tiers[0]
    assert.match(table, /\| medium \| sonnet \|/);
    assert.match(table, /\| low \| haiku \|/);
    assert.doesNotMatch(table, /\| max \(default\) \|/);
  });

  it("marks the default row on an identity whose default is not tiers[0]", () => {
    const decoupled: ProviderIdentity = {
      persona: "Decoupled",
      tiers: [
        { name: "ultra", model: "u" },
        { name: "std", model: "s" },
      ],
      defaultTier: "std",
      effortSupported: false,
    };
    const table = renderModelTierTable(decoupled);
    assert.match(table, /\| ultra \| u \|/);
    assert.match(table, /\| std \(default\) \| s \|/);
    assert.doesNotMatch(table, /\| ultra \(default\) \|/);
  });

  it("renders a 2-tier vocabulary as exactly 2 rows (drops the fixed-3 assumption)", () => {
    const twoTier: ProviderIdentity = {
      persona: "TwoTier",
      tiers: [
        { name: "medium", model: "m-pro" },
        { name: "low", model: "m-flash" },
      ],
      effortSupported: false,
    };
    const table = renderModelTierTable(twoTier);
    assert.equal(rowCount(table), 2);
    assert.match(table, /\| medium \(default\) \| m-pro \|/); // tiers[0] default
    assert.match(table, /\| low \| m-flash \|/);
    assert.doesNotMatch(table, /\| high \|/);
  });

  it("renders a 5-tier vocabulary as 5 rows, top rank → hardest, bottom → fastest", () => {
    const fiveTier: ProviderIdentity = {
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
    const table = renderModelTierTable(fiveTier);
    assert.equal(rowCount(table), 5);
    assert.match(table, /\| ultra \(default\) \| u \| ambiguous problems, multi-file design, debugging \|/); // tiers[0] default
    assert.match(table, /\| low \| l \| trivial edits, summaries, greps — fastest \|/);
  });

  it("prefers an operator-supplied hint over the rank-derived text", () => {
    const hinted: ProviderIdentity = {
      persona: "Hinted",
      tiers: [
        { name: "big", model: "b", hint: "custom guidance here" },
        { name: "small", model: "s" },
      ],
      effortSupported: false,
    };
    const table = renderModelTierTable(hinted);
    assert.match(table, /\| big \(default\) \| b \| custom guidance here \|/); // tiers[0] default
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
