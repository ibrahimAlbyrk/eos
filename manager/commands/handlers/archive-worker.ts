import type { CommandHandler } from "../pipeline.ts";
import {
  archiveWorkerCommand,
  type KillWorkerAddr,
  type ArchiveWorkerResponse,
} from "../../../contracts/src/commands/defs.ts";
import type { NoBody } from "../../../contracts/src/commands/types.ts";
import { archiveWorker } from "../../../core/src/use-cases/ArchiveWorker.ts";
import { assertOwnedBy } from "../../../core/src/services/WorkerOwnership.ts";
import type { createChildProcessSupervisor } from "../../../infra/src/supervision/ChildProcessSupervisor.ts";

export const archiveWorkerHandler: CommandHandler<KillWorkerAddr, NoBody, ArchiveWorkerResponse> = {
  def: archiveWorkerCommand,
  async run({ id, actorId }, _data, { c }) {
    // Scope check before any side effect — a denied foreign archive must not
    // touch the subtree. CLI (operator) omits actorId.
    if (actorId) assertOwnedBy(c.workers, actorId, id);
    const supervisorWithFind = c.supervisor as ReturnType<typeof createChildProcessSupervisor>;
    const result = archiveWorker(
      {
        workers: c.workers,
        pending: c.pending,
        bus: c.bus,
        clock: c.clock,
        supervisor: c.supervisor,
        findOrphanPids: (safeName) => supervisorWithFind.findPidsByPattern(`eos-${safeName}-`),
        // In-process backends (claude-sdk / API) have no supervised PTY child —
        // stop the session directly so its query/agent loop ends.
        stopBackendSession: (wid) => {
          const k = c.workers.findById(wid)?.backend_kind;
          if (k && c.backends.has(k)) c.backends.get(k).attach(wid, { kind: "inproc", ref: wid }).stop();
        },
      },
      id,
    );
    // In-memory pendings address a dead turn — cancel per subtree row, exactly
    // as kill does.
    for (const wid of result.archived) {
      c.pendingQuestions.cancelByWorker(wid);
      c.pendingPeerRequests.cancelByWorker(wid);
      c.backgroundActivity.clearWorker(wid);
    }
    return {
      status: 200,
      body: { id: result.id, archived: result.archived, was_state: result.wasState },
    };
  },
};
