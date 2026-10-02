// PruneOrphanScratch — daemon-startup sweep of "No folder" scratch dirs whose
// worker row is gone. The kill/purge cascade deletes the folder right after the
// row, so an orphan only exists when the daemon died in between (or a spawn
// failed half-way). Archived rows still own their folder — restore must find it.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { ScratchWorkspaces } from "../ports/ScratchWorkspaces.ts";
import type { Logger } from "../ports/Logger.ts";

export interface PruneOrphanScratchDeps {
  workers: Pick<WorkerRepo, "listAll">;
  scratch: ScratchWorkspaces;
  log: Logger;
}

export async function pruneOrphanScratch(deps: PruneOrphanScratchDeps): Promise<void> {
  // Any row still running in the folder keeps it (also a plain-cwd sub-agent of a scratch agent).
  const owned = new Set(deps.workers.listAll().map((w) => w.cwd));
  for (const dir of deps.scratch.list()) {
    if (owned.has(dir)) continue;
    await deps.scratch.remove(dir);
    deps.log.info("removed orphan scratch folder", { dir });
  }
}
