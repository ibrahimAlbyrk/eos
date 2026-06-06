// BackendDefaults — read-only view of the configured backend profiles + per-role
// defaults, injected into the resolver. Implemented in the composition root over
// the frozen config (manager/container.ts). Keeps the resolver pure + Node-free.

import type { BackendKind } from "../../../contracts/src/canonical.ts";

// A fully materialized backend choice for a worker.
export interface ResolvedBackend {
  kind: BackendKind;
  model: string;
  profileName: string | null; // null for ad-hoc (non-named) selections
  baseUrl?: string;
  pricing?: string;
  costMode?: "billed" | "included";
  params?: Record<string, unknown>;
}

export interface BackendDefaults {
  /** Resolve a named profile, or null if unknown. */
  profile(name: string): ResolvedBackend | null;
  /** The default profile name for a role, or null if none configured. */
  roleDefaultName(isOrchestrator: boolean): string | null;
}
