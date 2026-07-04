// Resolve a running backend to its ProviderIdentity — the persona + tier→model map
// the spawn tier gate and the DPI prompt read. Branches on descriptor DATA (the
// model-catalog family) and the config profile's origin, NEVER a lane/backend-kind
// string literal (backend-kind-literal-guard) — same discipline as model-provider.ts.

import type { BackendDescriptor } from "../../core/src/ports/AgentBackend.ts";
import { CLAUDE_IDENTITY, type ProviderIdentity } from "../../core/src/domain/model-tier.ts";
import type { ProviderCapabilities } from "../../contracts/src/provider-capabilities.ts";
import { findPresetByOrigin } from "./provider-presets.ts";

// The minimal profile facts identity resolution reads — satisfied by both a
// config BackendProfile and a ResolvedBackend.
export interface IdentityProfile {
  baseUrl?: string;
  model?: string;
}

// A provider exposes an effort lever iff it surfaces reasoning as Claude thinking
// or OpenAI effort; the token-echo styles ("reasoning_content") and "none" do not.
function effortFromReasoning(reasoning: ProviderCapabilities["reasoning"]): boolean {
  return reasoning === "openai-effort" || reasoning === "anthropic-thinking";
}

export function resolveProviderIdentity(
  descriptor: BackendDescriptor,
  profile?: IdentityProfile,
): ProviderIdentity {
  // Claude-family catalog (claude-cli, claude-sdk, and the metered anthropic-api
  // lane all declare models.kind "claude") → the Claude identity.
  if (descriptor.models.kind === "claude") return CLAUDE_IDENTITY;
  // A configured OpenAI-compatible provider whose origin matches a built-in preset
  // → that preset's persona + tiers, effort derived from its declared reasoning.
  const preset = findPresetByOrigin(profile?.baseUrl);
  if (preset) {
    return {
      persona: preset.persona,
      tiers: preset.tiers,
      effortSupported: effortFromReasoning(preset.capabilities.reasoning),
    };
  }
  // Unknown provider (self-host / proxy / no preset): collapse all tiers to the
  // profile's pinned model (or the descriptor label as a last resort), no effort.
  const model = profile?.model ?? descriptor.label;
  return {
    persona: descriptor.label,
    tiers: { high: model, medium: model, low: model },
    effortSupported: false,
  };
}
