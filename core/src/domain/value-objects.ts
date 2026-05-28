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

export interface ModelCatalog {
  priceFor(model: string | null | undefined): ModelPrice;
}

/**
 * Cost in USD for a usage report. Decoupled from any specific model catalog
 * — callers inject the catalog so prices can be config-driven.
 */
export function computeCostUsd(
  catalog: ModelCatalog,
  model: string | null | undefined,
  tokens: { in: number; out: number; cacheRead: number; cacheCreate: number; cacheCreate1h: number },
): number {
  const p = catalog.priceFor(model);
  return (
    (tokens.in * p.in +
      tokens.out * p.out +
      tokens.cacheRead * p.cacheRead +
      tokens.cacheCreate * p.cacheCreate +
      tokens.cacheCreate1h * p.cacheCreate1h) /
    1_000_000
  );
}
