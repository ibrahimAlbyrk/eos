// Value objects — pure data types with thin invariants. Kept as zero-runtime
// branded type aliases when possible; only adds a class when the wrapping
// invariant is non-trivial.

import type { WorkerState } from "../../../contracts/src/events.ts";

// Branded string IDs — distinguishable at the type level even though they're
// runtime strings. Constructed via the parse helpers below so call sites
// can't accidentally pass a worker id where a pending id is expected.

declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type WorkerId = Brand<string, "WorkerId">;
export type OrchestratorId = Brand<string, "OrchestratorId">;
export type PendingId = Brand<string, "PendingId">;
export type EventId = Brand<number, "EventId">;
export type ToolUseId = Brand<string, "ToolUseId">;

// Parser helpers. Named with the `Id` suffix on the value to avoid shadowing
// the matching TS type — `WorkerId` is the type, `WorkerIdParser.parse()`
// produces a branded instance.
export const WorkerIdParser = {
  parse(s: string): WorkerId {
    if (!s) throw new Error("WorkerId required");
    return s as WorkerId;
  },
} as const;

export const OrchestratorIdParser = {
  parse(s: string): OrchestratorId {
    if (!s) throw new Error("OrchestratorId required");
    return s as OrchestratorId;
  },
} as const;

export const PendingIdParser = {
  parse(s: string): PendingId {
    if (!s) throw new Error("PendingId required");
    return s as PendingId;
  },
} as const;

// Domain enums --------------------------------------------------------------

export const WorkerStateVO = {
  isTerminal(s: WorkerState): boolean {
    return s === "DONE";
  },
  isActive(s: WorkerState): boolean {
    return s === "SPAWNING" || s === "WORKING" || s === "IDLE";
  },
} as const;

// Cost calculation ----------------------------------------------------------

export interface ModelPrice {
  in: number;
  out: number;
  cacheRead: number;
  cacheCreate: number;     // 5-minute ephemeral writes (Anthropic: 1.25× input)
  cacheCreate1h: number;   // 1-hour ephemeral writes (Anthropic: 2× input)
}

// One band of a context-threshold ("tiered") price: the per-million rates that
// apply when a request's input-token count falls in this band. `maxInputTokens`
// is the INCLUSIVE upper bound of the band; null = unbounded (the final, open
// tier). Tiers are ordered ascending by maxInputTokens.
export interface PriceTier {
  maxInputTokens: number | null;
  price: ModelPrice;
}

// A tiered price: an ordered list of input-token-threshold tiers. Used for
// providers whose per-token rates change with prompt size (OpenAI's >272k
// surcharge, Gemini's ≤200k/>200k split, Qwen's multi-bucket tiers).
export interface TieredModelPrice {
  tiers: PriceTier[];
}

// A price spec is EITHER a flat ModelPrice (the single-tier degenerate case —
// what LiteLLM resolves and what existing configs hold) OR a TieredModelPrice.
export type ModelPriceSpec = ModelPrice | TieredModelPrice;

export function isTieredPrice(spec: ModelPriceSpec): spec is TieredModelPrice {
  return Array.isArray((spec as TieredModelPrice).tiers);
}

// Resolve a spec to the flat ModelPrice that applies for a request whose
// prompt-input token count is `inputTokens`. A flat spec returns itself (the
// degenerate single tier). For a tiered spec, returns the first tier whose band
// contains the count (falling back to the highest tier when the count exceeds
// every bounded tier, never $0).
export function selectTierPrice(spec: ModelPriceSpec, inputTokens: number): ModelPrice {
  if (!isTieredPrice(spec)) return spec;
  for (const tier of spec.tiers) {
    if (tier.maxInputTokens == null || inputTokens <= tier.maxInputTokens) return tier.price;
  }
  return spec.tiers[spec.tiers.length - 1].price;
}

export interface ModelCatalog {
  priceFor(model: string | null | undefined): ModelPriceSpec;
}

/**
 * Cost in USD for a usage report. Decoupled from any specific model catalog
 * — callers inject the catalog so prices can be config-driven.
 *
 * `tokens.in` is the BILLABLE (non-cached) input across all providers — Anthropic
 * reports input_tokens net of cache reads, and the OpenAI-compat clients subtract
 * cached_tokens from prompt_tokens for the same reason. So cached tokens bill ONCE
 * (at cacheRead), never at the input rate too.
 *
 * Tiered providers (OpenAI's >272k surcharge, Gemini's ≤200k/>200k split, Qwen's
 * buckets) key their thresholds off the FULL prompt size, which is the billable
 * input plus the cached input it served from cache — so tier selection uses
 * `tokens.in + tokens.cacheRead`. Flat (Anthropic) pricing makes this a no-op.
 */
export function computeCostUsd(
  catalog: ModelCatalog,
  model: string | null | undefined,
  tokens: { in: number; out: number; cacheRead: number; cacheCreate: number; cacheCreate1h: number },
): number {
  const p = selectTierPrice(catalog.priceFor(model), tokens.in + tokens.cacheRead);
  return (
    (tokens.in * p.in +
      tokens.out * p.out +
      tokens.cacheRead * p.cacheRead +
      tokens.cacheCreate * p.cacheCreate +
      tokens.cacheCreate1h * p.cacheCreate1h) /
    1_000_000
  );
}
