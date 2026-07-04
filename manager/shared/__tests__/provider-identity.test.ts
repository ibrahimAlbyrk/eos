import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveProviderIdentity } from "../provider-identity.ts";
import { findPreset } from "../provider-presets.ts";
import { CLAUDE_IDENTITY } from "../../../core/src/domain/model-tier.ts";
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

  it("an unknown origin → a generic collapsed identity (all tiers = the profile model, no effort)", () => {
    const id = resolveProviderIdentity(descriptor({ label: "My Proxy" }), { baseUrl: "https://proxy.internal", model: "local-7b" });
    assert.equal(id.persona, "My Proxy");
    assert.deepEqual(id.tiers, { high: "local-7b", medium: "local-7b", low: "local-7b" });
    assert.equal(id.effortSupported, false);
  });
});
