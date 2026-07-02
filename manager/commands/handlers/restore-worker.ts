import type { CommandHandler } from "../pipeline.ts";
import {
  restoreWorkerCommand,
  type WorkerIdAddr,
  type RestoreWorkerResponse,
} from "../../../contracts/src/commands/defs.ts";
import type { NoBody } from "../../../contracts/src/commands/types.ts";
import { restoreWorker } from "../../../core/src/use-cases/RestoreWorker.ts";

// Operator-only surface (no actorId by design — the Archive view is the sole
// caller) and no process concerns: restore is a metadata flip, revival stays
// ResumeWorker's job.
export const restoreWorkerHandler: CommandHandler<WorkerIdAddr, NoBody, RestoreWorkerResponse> = {
  def: restoreWorkerCommand,
  async run({ id }, _data, { c }) {
    const result = restoreWorker({ workers: c.workers, bus: c.bus }, id);
    return { status: 200, body: { id: result.id, restored: result.restored } };
  },
};
