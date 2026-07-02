import type { CommandHandler } from "../pipeline.ts";
import {
  killWorkerCommand,
  type KillWorkerAddr,
  type KillWorkerResponse,
} from "../../../contracts/src/commands/defs.ts";
import type { NoBody } from "../../../contracts/src/commands/types.ts";
import { killWorker } from "../../../core/src/use-cases/KillWorker.ts";
import { assertOwnedBy } from "../../../core/src/services/WorkerOwnership.ts";
import type { createChildProcessSupervisor } from "../../../infra/src/supervision/ChildProcessSupervisor.ts";

export const killWorkerHandler: CommandHandler<KillWorkerAddr, NoBody, KillWorkerResponse> = {
  def: killWorkerCommand,
  async run({ id, actorId }, _data, { c }) {
    // Scope check before any side effect — a denied foreign kill must not touch
    // the subtree. CLI (operator) omits actorId; MCP passes session.selfId.
    if (actorId) assertOwnedBy(c.workers, actorId, id);
    const supervisorWithFind = c.supervisor as ReturnType<typeof createChildProcessSupervisor>;
    const result = killWorker(
      {
        workers: c.workers,
        events: c.events,
        pending: c.pending,
        messageQueue: c.messageQueue,
        // Adopted leak cleanups (shared cascade): loop rows + the conversation
        // transcript keyed by the row's session_id.
        loops: c.loops,
        deleteConversation: c.deleteConversation,
        bus: c.bus,
        supervisor: c.supervisor,
        log: c.log,
        clock: c.clock,
        findOrphanPids: (safeName) => supervisorWithFind.findPidsByPattern(`eos-${safeName}-`),
        // In-process backends (claude-sdk / API) have no supervised PTY child —
        // stop the session directly so its query/agent loop ends.
        stopBackendSession: (wid) => {
          const k = c.workers.findById(wid)?.backend_kind;
          if (k && c.backends.has(k)) c.backends.get(k).attach(wid, { kind: "inproc", ref: wid }).stop();
        },
        postKillCleanup: (wid) => {
          c.cleanupMcpConfig(wid);
        },
        // Worktree + try-snapshot teardown is recorded durably and drained by
        // the reaper (ReapWorktreeRemovals), once this row is gone.
        worktreeRemovals: c.worktreeRemovals,
      },
      id,
    );
    c.pendingQuestions.cancelByWorker(id);
    c.pendingPeerRequests.cancelByWorker(id);
    c.backgroundActivity.clearWorker(id);
    return {
      status: 200,
      body: {
        killed: result.killed,
        removed: result.removed,
        was_state: result.wasState,
        id: result.id,
        name: result.name,
      },
    };
  },
};
