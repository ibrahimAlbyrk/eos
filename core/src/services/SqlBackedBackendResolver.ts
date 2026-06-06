// SqlBackedBackendResolver — decides the effective backend for a NEW worker.
// Resolution order (highest first), mirroring SqlBackedModeResolver's parent_id
// climb so backend inheritance behaves like permission-mode inheritance:
//   1. explicit named profile on the spawn request
//   2. inherited: the nearest ancestor with an explicit backend (profile or kind)
//   3. role default (config defaults.{orchestrator,worker}.backend)
//   4. global default — claude-cli (preserves today's behavior)
// A child therefore inherits its orchestrator's backend unless it overrides it,
// which is exactly the "worker on X, orchestrator on Y" requirement.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { BackendDefaults, ResolvedBackend } from "../ports/BackendDefaults.ts";
import type { BackendKind } from "../../../contracts/src/canonical.ts";

export interface ResolveBackendInput {
  explicitProfileName?: string | null;
  parentId?: string | null;
  isOrchestrator: boolean;
}

export class SqlBackedBackendResolver {
  private readonly workers: WorkerRepo;
  private readonly defaults: BackendDefaults;

  constructor(workers: WorkerRepo, defaults: BackendDefaults) {
    this.workers = workers;
    this.defaults = defaults;
  }

  resolveForNewWorker(input: ResolveBackendInput): ResolvedBackend {
    // 1. explicit
    if (input.explicitProfileName) {
      const p = this.defaults.profile(input.explicitProfileName);
      if (p) return p;
    }
    // 2. inherit from the parent chain
    let cursor: string | null | undefined = input.parentId ?? null;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const w = this.workers.findById(cursor);
      if (!w) break;
      if (w.backend_profile) {
        const p = this.defaults.profile(w.backend_profile);
        if (p) return p;
      }
      if (w.backend_kind) {
        return { kind: w.backend_kind as BackendKind, model: w.model ?? "opus", profileName: w.backend_profile ?? null };
      }
      cursor = w.parent_id ?? null;
    }
    // 3. role default
    const roleName = this.defaults.roleDefaultName(input.isOrchestrator);
    const role = roleName ? this.defaults.profile(roleName) : null;
    if (role) return role;
    // 4. global default — preserves today's behavior when nothing is configured
    return { kind: "claude-cli", model: "opus", profileName: null };
  }
}
