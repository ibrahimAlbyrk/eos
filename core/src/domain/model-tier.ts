// Provider-agnostic model tiers. A spawn requests a TIER (a provider-defined power
// name like "high"/"max"/"ultra"), not a concrete model id; each provider resolves
// the tier to its own model at the spawn chokepoint. This is the ONE-WAY gate —
// downstream (DB rows, spawner, price lookup) only ever sees the concrete model a
// tier resolved to, never a tier name.
//
// Each provider owns an ORDERED tier vocabulary of arbitrary length (strongest-first)
// — not a fixed high/medium/low triple. The default tier is `defaultTier` when set,
// else tiers[0] (so "default" is decoupled from "strongest": Claude lists max=fable
// strongest-first but still defaults to high=opus). The persona + tier list for a
// provider is a ProviderIdentity (resolved in manager from the backend descriptor /
// config profile). This file is the pure domain: the Claude identity, the legacy-alias
// fallback, and the tier→model resolver + predicates.
//
// NOTE: tiers (WHICH model) are orthogonal to effort (reasoning depth, the 5-value
// EFFORT_LEVELS enum in contracts). They share the substrings low/medium/high but
// must never be entangled — do not wire EFFORT_LEVELS into tier resolution.

// A single tier: a provider-defined label + the concrete model it resolves to, with
// optional "use for" guidance the prompt table shows (falls back to rank-derived text).
export interface TierSpec {
  name: string;
  model: string;
  hint?: string;
}

// The canonical ranked baseline names, strongest-first. Every built-in provider
// defines these three so legacy `model: "high"|"medium"|"low"` requests and the
// Claude-alias fallback resolve cleanly. Names are NOT an enforced superset — a
// provider may add ("max"/"ultra") or expose fewer.
export const BASELINE_TIER_NAMES = ["high", "medium", "low"] as const;
export type ModelTier = (typeof BASELINE_TIER_NAMES)[number];

export interface ProviderIdentity {
  // How the model refers to itself in its own prompt ("Claude", "DeepSeek", …).
  persona: string;
  // The provider's ordered tier vocabulary, strongest→weakest, length ≥ 1.
  tiers: TierSpec[];
  // The default tier name — the tier a spawn gets when none is requested. Omitted ⇒
  // tiers[0] (the strongest). Set it to decouple "default" from "strongest" (Claude:
  // strongest is max=fable, but default stays high=opus). Must name an existing tier.
  defaultTier?: string;
  // Whether the provider exposes a reasoning-effort lever (Claude thinking /
  // OpenAI effort). False providers omit the effort guidance entirely.
  effortSupported: boolean;
}

// Claude is request-model (the composer picks the alias directly), so its tiers ARE
// the aliases and effort is supported. Shared by claude-cli, claude-sdk, and the
// metered anthropic-api lane (all Claude-family — descriptor.models.kind "claude").
export const CLAUDE_IDENTITY: ProviderIdentity = {
  persona: "Claude",
  // Strongest-first (max=fable is the strongest), but the DEFAULT stays high=opus —
  // adding a stronger tier must not silently upgrade every unspecified spawn.
  tiers: [
    { name: "max", model: "fable" },
    { name: "high", model: "opus" },
    { name: "medium", model: "sonnet" },
    { name: "low", model: "haiku" },
  ],
  defaultTier: "high",
  effortSupported: true,
};

// A legacy Claude alias, passed to a NON-Claude provider, maps to a baseline rank
// name so the provider still resolves it to one of its own models rather than
// 400-ing on a foreign id. On a Claude identity these aliases are the real models
// (passthrough).
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

// The vocabulary's tier names, in order (strongest-first).
export function tierNames(identity: ProviderIdentity): string[] {
  return identity.tiers.map((t) => t.name);
}

// The default tier name — `defaultTier` when set, else the strongest (tiers[0]).
// Decoupled from tiers[0] so a provider can list a stronger tier without changing
// what an unspecified spawn resolves to.
export function defaultTierName(identity: ProviderIdentity): string {
  return identity.defaultTier ?? identity.tiers[0].name;
}

// Does this provider define a tier by this name?
export function hasTier(identity: ProviderIdentity, name: string): boolean {
  return identity.tiers.some((t) => t.name === name);
}

// Dev-time invariant guard (total, pure): a `defaultTier` that names no existing tier
// is a config/seed bug. True when defaultTier is unset (⇒ tiers[0]) or names a real
// tier. Used by tests and by manager to reject/fall-back a bad config default.
export function defaultTierIsValid(identity: ProviderIdentity): boolean {
  return identity.defaultTier === undefined || hasTier(identity, identity.defaultTier);
}

// Resolve a legacy Claude alias's baseline rank name against the vocabulary: exact
// name when defined, else clamp to the nearest defined baseline rank (walk outward,
// preferring the stronger side on a tie). When the vocabulary defines NO baseline
// name at all (fully custom names), fall back to the default (strongest) tier.
function resolveBaselineName(baseline: ModelTier, identity: ProviderIdentity): string {
  const bi = BASELINE_TIER_NAMES.indexOf(baseline);
  for (let d = 0; d < BASELINE_TIER_NAMES.length; d++) {
    for (const idx of [bi - d, bi + d]) {
      if (idx < 0 || idx >= BASELINE_TIER_NAMES.length) continue;
      const hit = identity.tiers.find((t) => t.name === BASELINE_TIER_NAMES[idx]);
      if (hit) return hit.model;
    }
  }
  return identity.tiers[0].model;
}

// Resolve a requested model against a provider identity → a concrete model id.
// Pure and TOTAL (never throws — the unsupported-tier rejection lives at the spawn
// chokepoint, where the provider-family signal disambiguates a typo'd tier from a
// legitimate concrete id).
//   - a defined tier name → the identity's model for that tier
//   - a legacy Claude alias, on a NON-Claude identity → the alias's baseline rank
//     name resolved (and clamped) against the vocabulary
//   - anything else (a concrete id) → passthrough
export function resolveTier(model: string, identity: ProviderIdentity): string {
  const tier = identity.tiers.find((t) => t.name === model);
  if (tier) return tier.model;
  const baseline = ALIAS_TIER_FALLBACK[model];
  if (baseline && !isClaudeIdentity(identity)) {
    return resolveBaselineName(baseline, identity);
  }
  return model;
}
