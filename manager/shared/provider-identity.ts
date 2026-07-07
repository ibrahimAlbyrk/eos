// Resolve a running backend to its ProviderIdentity — the persona + tier→model map
// the spawn tier gate and the DPI prompt read. Branches on descriptor DATA (the
// model-catalog family) and the config profile's origin, NEVER a lane/backend-kind
// string literal (backend-kind-literal-guard) — same discipline as model-provider.ts.

import type { BackendDescriptor } from "../../core/src/ports/AgentBackend.ts";
import { CLAUDE_IDENTITY, type ProviderIdentity, type TierSpec } from "../../core/src/domain/model-tier.ts";
import type { ProviderCapabilities } from "../../contracts/src/provider-capabilities.ts";
import { findPresetByOrigin } from "./provider-presets.ts";

// The minimal profile facts identity resolution reads — satisfied by both a
// config BackendProfile and a ResolvedBackend.
export interface IdentityProfile {
  baseUrl?: string;
  model?: string;
  // Operator-defined tier vocabulary (config BackendProfile.tiers); wins over the
  // by-origin preset / claude / collapse fallbacks when present.
  tiers?: TierSpec[];
  // Operator-chosen default tier (config BackendProfile.defaultTier); applied onto the
  // resolved identity when it names one of its tiers, else ignored (fall back to
  // tiers[0]) with a warn. Omit ⇒ tiers[0].
  defaultTier?: string;
}

// Minimal logger shape (warn only) so a bad config defaultTier can be surfaced
// without threading the full Logger port through pure identity resolution.
type IdentityLogger = { warn: (event: string, data?: Record<string, unknown>) => void };

// A provider exposes an effort lever iff it surfaces reasoning as Claude thinking
// or OpenAI effort; the token-echo styles ("reasoning_content") and "none" do not.
function effortFromReasoning(reasoning: ProviderCapabilities["reasoning"]): boolean {
  return reasoning === "openai-effort" || reasoning === "anthropic-thinking";
}

export function resolveProviderIdentity(
  descriptor: BackendDescriptor,
  profile?: IdentityProfile,
  log?: IdentityLogger,
): ProviderIdentity {
  return withProfileDefaultTier(resolveBaseIdentity(descriptor, profile), profile?.defaultTier, log);
}

// The persona + tier vocabulary + effort, before any config defaultTier override.
function resolveBaseIdentity(descriptor: BackendDescriptor, profile?: IdentityProfile): ProviderIdentity {
  const isClaude = descriptor.models.kind === "claude";
  const preset = findPresetByOrigin(profile?.baseUrl);
  // (1) Operator-defined tiers on the config profile win for ANY family — the
  // "we define them" path. Persona/effort still come from the family/preset. The
  // seed's defaultTier is NOT carried over (the override vocabulary may not contain
  // it); a config defaultTier is applied by withProfileDefaultTier instead.
  if (profile?.tiers && profile.tiers.length > 0) {
    if (isClaude) {
      return { persona: CLAUDE_IDENTITY.persona, tiers: profile.tiers, effortSupported: CLAUDE_IDENTITY.effortSupported };
    }
    if (preset) {
      return {
        persona: preset.persona,
        tiers: profile.tiers,
        effortSupported: effortFromReasoning(preset.capabilities.reasoning),
      };
    }
    return { persona: descriptor.label, tiers: profile.tiers, effortSupported: false };
  }
  // (2) Claude-family catalog (claude-cli, claude-sdk, and the metered anthropic-api
  // lane all declare models.kind "claude") → the Claude identity (returned as-is so
  // callers keep reference identity when no config override applies).
  if (isClaude) return CLAUDE_IDENTITY;
  // (3) A configured OpenAI-compatible provider whose origin matches a built-in
  // preset → that preset's persona + tiers, effort derived from its declared reasoning.
  if (preset) {
    return {
      persona: preset.persona,
      tiers: preset.tiers,
      effortSupported: effortFromReasoning(preset.capabilities.reasoning),
    };
  }
  // (4) Unknown provider (self-host / proxy / no preset): collapse to the baseline
  // triple, all pointing at the profile's pinned model (or the descriptor label as a
  // last resort), strongest-first so tiers[0]="high" stays the default. No effort.
  const model = profile?.model ?? descriptor.label;
  return {
    persona: descriptor.label,
    tiers: [
      { name: "high", model },
      { name: "medium", model },
      { name: "low", model },
    ],
    effortSupported: false,
  };
}

// Apply a config-chosen default tier onto the resolved identity: keep it only when it
// names a real tier (validated per-spec, do NOT throw at spawn); otherwise warn and
// leave the identity's own default (tiers[0]). Returns the base unchanged when there
// is nothing to override, preserving reference identity for the shared CLAUDE_IDENTITY.
function withProfileDefaultTier(base: ProviderIdentity, defaultTier: string | undefined, log?: IdentityLogger): ProviderIdentity {
  if (!defaultTier || defaultTier === base.defaultTier) return base;
  if (base.tiers.some((t) => t.name === defaultTier)) return { ...base, defaultTier };
  log?.warn("default_tier_not_in_vocabulary", { persona: base.persona, defaultTier, tiers: base.tiers.map((t) => t.name) });
  return base;
}
