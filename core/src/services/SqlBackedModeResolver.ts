// SqlBackedModeResolver — walks the worker tree (worker → parent_id) to find
// the first ancestor with an explicit permission_mode. Falls back to
// "default" when nothing is set anywhere in the chain.
//
// O(depth) worst case; in practice we snapshot mode at spawn time, so a
// single read usually wins.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { PermissionModeResolver } from "../ports/PermissionModeResolver.ts";
import type { PermissionMode } from "../domain/permission-mode.ts";
import { PermissionModeSchema } from "../../../contracts/src/worker.ts";

const VALID_MODES: ReadonlySet<PermissionMode> = new Set(PermissionModeSchema.options);

function asMode(value: string | null | undefined): PermissionMode | null {
  if (!value) return null;
  return VALID_MODES.has(value as PermissionMode) ? (value as PermissionMode) : null;
}

export class SqlBackedModeResolver implements PermissionModeResolver {
  private readonly workers: WorkerRepo;

  constructor(workers: WorkerRepo) {
    this.workers = workers;
  }

  resolveFor(workerId: string): PermissionMode {
    let cursor: string | null | undefined = workerId;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const w = this.workers.findById(cursor);
      if (!w) break;
      const mode = asMode(w.permission_mode);
      if (mode) return mode;
      cursor = w.parent_id ?? null;
    }
    return "default";
  }
}
