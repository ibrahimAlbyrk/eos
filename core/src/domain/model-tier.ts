// Provider-agnostic model tiers. A spawn requests a TIER (high/medium/low), not a
// concrete model id; each provider resolves the tier to its own model at the spawn
// chokepoint. This is the ONE-WAY gate — downstream (DB rows, spawner, price
// lookup) only ever sees the concrete model a tier resolved to, never a tier name.
//
// The persona + tier map for a provider is a ProviderIdentity (resolved in manager
// from the backend descriptor / config profile). This file is the pure domain: the
// Claude identity, the legacy-alias fallback, and the tier→model resolver.

export type ModelTier = "high" | "medium" | "low";

export interface TierMap {
  high: string;
  medium: string;
  low: string;
}

export interface ProviderIdentity {
  // How the model refers to itself in its own prompt ("Claude", "DeepSeek", …).
  persona: string;
  // The concrete model id each tier resolves to for this provider.
  tiers: TierMap;
  // Whether the provider exposes a reasoning-effort lever (Claude thinking /
  // OpenAI effort). False providers omit the effort guidance entirely.
  effortSupported: boolean;
}

// Claude is request-model (the composer picks the alias directly), so its tiers ARE
// the aliases and effort is supported. Shared by claude-cli, claude-sdk, and the
// metered anthropic-api lane (all Claude-family — descriptor.models.kind "claude").
export const CLAUDE_IDENTITY: ProviderIdentity = {
  persona: "Claude",
  tiers: { high: "opus", medium: "sonnet", low: "haiku" },
  effortSupported: true,
};

// A legacy Claude alias, passed to a NON-Claude provider, maps to a tier so the
// provider still resolves it to one of its own models rather than 400-ing on a
// foreign id. On a Claude identity these aliases are the real models (passthrough).
export const ALIAS_TIER_FALLBACK: Record<string, ModelTier> = {
  opus: "high",
  sonnet: "medium",
  haiku: "low",
  fable: "high",
};

// True when this identity is Claude-family (persona check, not reference equality:
// the anthropic-api lane returns the same CLAUDE_IDENTITY, and no non-Claude preset
// uses the "Claude" persona).
export function isClaudeIdentity(identity: ProviderIdentity): boolean {
  return identity.persona === CLAUDE_IDENTITY.persona;
}

// Resolve a requested model against a provider identity → a concrete model id.
//   - a tier name (high/medium/low) → the identity's model for that tier
//   - a legacy Claude alias → the tier fallback, ONLY for non-Claude identities
//     (on a Claude identity the alias IS the model, so it passes through)
//   - anything else (a concrete id) → passthrough
export function resolveTier(model: string, identity: ProviderIdentity): string {
  if (model === "high" || model === "medium" || model === "low") {
    return identity.tiers[model];
  }
  const alias = ALIAS_TIER_FALLBACK[model];
  if (alias && !isClaudeIdentity(identity)) {
    return identity.tiers[alias];
  }
  return model;
}
