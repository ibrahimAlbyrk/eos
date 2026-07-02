import type { CommandHandler } from "../pipeline.ts";
import {
  purgeWorkerCommand,
  type KillWorkerAddr,
  type PurgeWorkerResponse,
} from "../../../contracts/src/commands/defs.ts";
import type { NoBody } from "../../../contracts/src/commands/types.ts";
import { purgeWorker } from "../../../core/src/use-cases/PurgeWorker.ts";
import { assertOwnedBy } from "../../../core/src/services/WorkerOwnership.ts";

// The destructive half of the archive split: the full kill cascade, gated in
// the use-case on the row being archived (409 otherwise). No process concerns —
// archive already stopped everything.
export const purgeWorkerHandler: CommandHandler<KillWorkerAddr, NoBody, PurgeWorkerResponse> = {
  def: purgeWorkerCommand,
  async run({ id, actorId }, _data, { c }) {
    if (actorId) assertOwnedBy(c.workers, actorId, id);
    const result = purgeWorker(
      {
        workers: c.workers,
        events: c.events,
        pending: c.pending,
        messageQueue: c.messageQueue,
        loops: c.loops,
        deleteConversation: c.deleteConversation,
        bus: c.bus,
        postKillCleanup: (wid) => {
          c.cleanupMcpConfig(wid);
        },
        worktreeRemovals: c.worktreeRemovals,
        clock: c.clock,
      },
      id,
    );
    return { status: 200, body: result };
  },
};
