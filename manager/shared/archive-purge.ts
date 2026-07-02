// Maps the container to the archive auto-purge deps — one composition point
// shared by the daemon's retention sweeper (container.ts) and the app-close
// route (routes/workers.ts), mirroring the purge-worker command handler's
// wiring so every auto-purge runs the exact same cascade.

import type { Container } from "../container.ts";
import type { PurgeExpiredArchivesDeps } from "../../core/src/use-cases/PurgeExpiredArchives.ts";

export function archivePurgeDeps(c: Container): PurgeExpiredArchivesDeps {
  return {
    workers: c.workers,
    events: c.events,
    pending: c.pending,
    messageQueue: c.messageQueue,
    loops: c.loops,
    deleteConversation: (sessionId) => c.deleteConversation(sessionId),
    bus: c.bus,
    postKillCleanup: (workerId) => {
      c.cleanupMcpConfig(workerId);
    },
    worktreeRemovals: c.worktreeRemovals,
    clock: c.clock,
    log: c.log,
  };
}
