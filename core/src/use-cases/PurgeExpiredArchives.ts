// PurgeExpiredArchives — archive retention: age-based auto-purge of archived
// subtree ROOTS through the real purgeWorker cascade (never raw deletes).
// Two entry points share the root scan: purgeExpiredArchives (the daemon's
// boot + interval sweeper, gated on config archive.retention) and
// purgeAllArchived (the app-close hook, gated on archive.purgeOnAppClose at
// the route). Children are removed by the root's cascade, so only roots are
// iterated — an archived child under a live parent is a root of its own
// archived subtree (ADR-7 allows that shape).

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";
import { purgeWorker, type PurgeWorkerDeps } from "./PurgeWorker.ts";

export type ArchiveRetention = "off" | "daily" | "weekly" | "monthly";

const DAY_MS = 24 * 60 * 60 * 1000;
export const RETENTION_PERIOD_MS: Record<Exclude<ArchiveRetention, "off">, number> = {
  daily: DAY_MS,
  weekly: 7 * DAY_MS,
  monthly: 30 * DAY_MS,
};

export interface PurgeExpiredArchivesDeps extends PurgeWorkerDeps {
  workers: PurgeWorkerDeps["workers"] & Pick<WorkerRepo, "listArchived">;
  clock: Clock;
  log: Logger;
}

// Archived subtree roots: archived rows whose parent is null, gone (purged/
// killed), or not archived itself.
function archivedRoots(deps: PurgeExpiredArchivesDeps): WorkerRow[] {
  return deps.workers.listArchived().filter((w) => {
    if (w.parent_id == null) return true;
    const parent = deps.workers.findById(w.parent_id);
    return !parent || parent.archived_at == null;
  });
}

// Purges every archived root whose archived_at age has reached the retention
// period (>= — a root archived exactly one period ago is eligible). "off"
// never purges. Returns the purged root ids.
export function purgeExpiredArchives(
  deps: PurgeExpiredArchivesDeps,
  retention: ArchiveRetention,
): string[] {
  if (retention === "off") return [];
  const periodMs = RETENTION_PERIOD_MS[retention];
  const now = deps.clock.now();
  const expired = archivedRoots(deps).filter(
    (w) => w.archived_at != null && now - w.archived_at >= periodMs,
  );
  return purgeRoots(deps, expired);
}

// Purges every archived root regardless of age — the purge-on-app-close path.
// Idempotent: a second call finds nothing archived and returns [].
export function purgeAllArchived(deps: PurgeExpiredArchivesDeps): string[] {
  return purgeRoots(deps, archivedRoots(deps));
}

function purgeRoots(deps: PurgeExpiredArchivesDeps, roots: WorkerRow[]): string[] {
  const purged: string[] = [];
  for (const root of roots) {
    try {
      purgeWorker(deps, root.id);
      purged.push(root.id);
    } catch (e) {
      // One bad root must not block the rest; the next sweep retries it.
      deps.log.warn("archive auto-purge failed — will retry next sweep", {
        workerId: root.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return purged;
}
