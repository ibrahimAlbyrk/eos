import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProviderIdentity } from "../provider-identity.ts";
import { findPreset } from "../provider-presets.ts";
import { CLAUDE_IDENTITY, defaultTierName } from "../../../core/src/domain/model-tier.ts";
import type { AgentCapabilities, BackendDescriptor, ModelCatalogRef } from "../../../core/src/ports/AgentBackend.ts";

const caps: AgentCapabilities = { interrupt: true, keystroke: false, rewind: false, runtimeModelSwitch: false, runtimePermissionSwitch: false };
const descriptor = (over: { kind?: string; label?: string; models?: ModelCatalogRef }): BackendDescriptor => ({
  kind: over.kind ?? "openai",
  label: over.label ?? "OpenAI API",
  processModel: "in-process", billing: "metered", modelSource: "profile", capabilities: caps,
  models: over.models ?? { kind: "openai-compatible" },
  auth: "apikey", enabled: true, sessionStore: "eos-conversation", wireDialect: "openai-chat",
});

describe("resolveProviderIdentity", () => {
  it("a claude-family descriptor → the Claude identity (regardless of profile)", () => {
    const id = resolveProviderIdentity(descriptor({ kind: "claude-sdk", label: "Claude SDK", models: { kind: "claude" } }));
    assert.equal(id, CLAUDE_IDENTITY);
    // The metered anthropic-api lane is also claude-family.
    const api = resolveProviderIdentity(descriptor({ kind: "anthropic-api", label: "Anthropic API", models: { kind: "claude" } }));
    assert.equal(api, CLAUDE_IDENTITY);
  });

  it("a deepseek baseUrl → the deepseek preset identity (persona + tiers)", () => {
    const preset = findPreset("deepseek")!;
    const id = resolveProviderIdentity(descriptor({}), { baseUrl: "https://api.deepseek.com" });
    assert.equal(id.persona, "DeepSeek");
    assert.deepEqual(id.tiers, preset.tiers);
    // deepseek's reasoning is "reasoning_content" → no effort lever.
    assert.equal(id.effortSupported, false);
  });

  it("effortSupported comes from the preset's reasoning capability (openai-effort ⇒ true)", () => {
    const id = resolveProviderIdentity(descriptor({}), { baseUrl: "https://api.openai.com" });
    assert.equal(id.persona, "GPT");
    assert.equal(id.effortSupported, true);
  });

  it("an unknown origin → a generic collapsed identity (baseline triple = the profile model, no effort)", () => {
    const id = resolveProviderIdentity(descriptor({ label: "My Proxy" }), { baseUrl: "https://proxy.internal", model: "local-7b" });
    assert.equal(id.persona, "My Proxy");
    assert.deepEqual(id.tiers, [
      { name: "high", model: "local-7b" },
      { name: "medium", model: "local-7b" },
      { name: "low", model: "local-7b" },
    ]);
    // tiers[0] is the default → still "high" for legacy resolution.
    assert.equal(id.tiers[0].name, "high");
    assert.equal(id.effortSupported, false);
  });

  it("config profile.tiers WIN over the by-origin preset (the operator-defined path)", () => {
    const custom = [
      { name: "max", model: "deepseek-v4-pro" },
      { name: "mid", model: "deepseek-v4-flash" },
    ];
    // Same deepseek origin as above, but the profile carries its own vocabulary.
    const id = resolveProviderIdentity(descriptor({}), { baseUrl: "https://api.deepseek.com", tiers: custom });
    assert.deepEqual(id.tiers, custom);
    // persona + effort still derive from the matched preset.
    assert.equal(id.persona, "DeepSeek");
    assert.equal(id.effortSupported, false);
  });

  it("config profile.tiers override a claude-family profile too (persona/effort stay Claude, no stale default)", () => {
    const custom = [
      { name: "flagship", model: "opus" },
      { name: "cheap", model: "haiku" },
    ];
    const id = resolveProviderIdentity(
      descriptor({ kind: "claude-sdk", label: "Claude SDK", models: { kind: "claude" } }),
      { tiers: custom },
    );
    assert.deepEqual(id.tiers, custom);
    assert.equal(id.persona, "Claude");
    assert.equal(id.effortSupported, true);
    // The override must NOT inherit CLAUDE_IDENTITY's "high" default (absent here) —
    // it falls back to tiers[0] of the new vocabulary.
    assert.equal(id.defaultTier, undefined);
    assert.equal(defaultTierName(id), "flagship");
  });
});

describe("resolveProviderIdentity — config defaultTier", () => {
  it("applies a config defaultTier that names a real tier (decoupled from tiers[0])", () => {
    const id = resolveProviderIdentity(descriptor({}), { baseUrl: "https://api.deepseek.com", defaultTier: "low" });
    assert.equal(id.defaultTier, "low");
    assert.equal(defaultTierName(id), "low"); // not tiers[0] ("high")
  });

  it("applies a config defaultTier over an operator-defined tiers vocabulary", () => {
    const custom = [
      { name: "max", model: "deepseek-v4-pro" },
      { name: "mid", model: "deepseek-v4-flash" },
    ];
    const id = resolveProviderIdentity(descriptor({}), { baseUrl: "https://api.deepseek.com", tiers: custom, defaultTier: "mid" });
    assert.equal(defaultTierName(id), "mid");
  });

  it("ignores an invalid config defaultTier — falls back to tiers[0] and warns (no throw)", () => {
    const warnings: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const log = { warn: (event: string, data?: Record<string, unknown>) => warnings.push({ event, data }) };
    const id = resolveProviderIdentity(descriptor({}), { baseUrl: "https://api.deepseek.com", defaultTier: "nope" }, log);
    assert.equal(id.defaultTier, undefined); // not set to the bogus name
    assert.equal(defaultTierName(id), "high"); // tiers[0]
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].event, "default_tier_not_in_vocabulary");
  });

  it("keeps CLAUDE_IDENTITY reference identity when no config defaultTier is supplied", () => {
    const id = resolveProviderIdentity(descriptor({ kind: "claude-sdk", label: "Claude SDK", models: { kind: "claude" } }));
    assert.equal(id, CLAUDE_IDENTITY); // reference preserved
    assert.equal(defaultTierName(id), "high"); // its own decoupled default
  });
});
