// BackendDefaults — read-only view of the configured backend profiles + per-role
// defaults, injected into the resolver. Implemented in the composition root over
// the frozen config (manager/container.ts). Keeps the resolver pure + Node-free.

import type { BackendKind } from "../../../contracts/src/canonical.ts";
import type { AuthRef } from "../../../contracts/src/backend.ts";
import type { ProviderCapabilities } from "../../../contracts/src/provider-capabilities.ts";

// A fully materialized backend choice for a worker.
export interface ResolvedBackend {
  kind: BackendKind;
  model: string;
  profileName: string | null; // null for ad-hoc (non-named) selections
  baseUrl?: string;
  // The profile's credential REFERENCE (never a secret) — mapped at profile() and
  // threaded to the in-process env factory, which resolves it lazily at start().
  auth?: AuthRef;
  pricing?: string;
  costMode?: "billed" | "included";
  params?: Record<string, unknown>;
  // Declared per-provider quirks (contextWindow etc.) carried from the profile.
  capabilities?: ProviderCapabilities;
}

export interface BackendDefaults {
  /** Resolve a named profile, or null if unknown. */
  profile(name: string): ResolvedBackend | null;
  /** The default profile name for a role, or null if none configured. */
  roleDefaultName(isOrchestrator: boolean): string | null;
}
