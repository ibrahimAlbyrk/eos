// SqlBackedToolScopeResolver — reads the materialized tool_scope JSON off the
// worker row. Flat lookup (no parent climb): tool scope is baked at spawn and
// session-immutable. Caches per workerId with NO invalidation for the same
// reason. A missing row is NOT cached (the gate may fire mid-insert race).

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { WorkerToolScopeResolver } from "../ports/WorkerToolScopeResolver.ts";
import { ToolScopeSchema, type ToolScope } from "../../../contracts/src/worker-definition.ts";

export class SqlBackedToolScopeResolver implements WorkerToolScopeResolver {
  private readonly workers: WorkerRepo;
  private readonly cache = new Map<string, ToolScope | null>();

  constructor(workers: WorkerRepo) {
    this.workers = workers;
  }

  resolveFor(workerId: string): ToolScope | null {
    const cached = this.cache.get(workerId);
    if (cached !== undefined) return cached;
    const w = this.workers.findById(workerId);
    if (!w) return null; // row not present yet — don't cache the miss
    const scope = parseScope(w.tool_scope ?? null);
    this.cache.set(workerId, scope);
    return scope;
  }
}

function parseScope(raw: string | null): ToolScope | null {
  if (!raw) return null;
  try {
    const result = ToolScopeSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
