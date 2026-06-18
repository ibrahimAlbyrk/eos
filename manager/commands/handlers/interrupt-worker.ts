import type { CommandHandler } from "../pipeline.ts";
import {
  interruptWorkerCommand,
  type WorkerIdAddr,
  type InterruptWorkerResponse,
} from "../../../contracts/src/commands/defs.ts";
import type { NoBody } from "../../../contracts/src/commands/types.ts";
import { transitionState } from "../../../core/src/use-cases/TransitionState.ts";

export const interruptWorkerHandler: CommandHandler<WorkerIdAddr, NoBody, InterruptWorkerResponse> = {
  def: interruptWorkerCommand,
  async run({ id }, _data, { c }) {
    const worker = c.workers.findById(id);
    if (!worker) return { status: 404, body: { error: "worker not found" } };
    // Route through the backend session so interrupt works on every lane: CLI →
    // httpWorkerClient.sendInterrupt(port); in-process (claude-sdk / API) → the
    // session's own interrupt (SDK query / agent-loop abort). No port assumption.
    const kind = worker.backend_kind ?? "claude-cli";
    const backend = c.backends.has(kind) ? c.backends.get(kind) : c.claudeCliBackend;
    const handle = backend.descriptor.processModel === "out-of-process"
      ? { kind: "http" as const, port: worker.port, pid: worker.pid ?? null }
      : { kind: "inproc" as const, ref: id };
    const session = backend.attach(id, handle);
    if (!session.isAlive()) return { status: 409, body: { error: "worker not running" } };
    if (!session.capabilities.interrupt) return { status: 409, body: { error: "backend does not support interrupt" } };
    // Esc cancels what the user queued — clear BEFORE the IDLE transition or the
    // drain would fire the queued messages the interrupt meant to stop.
    const clearedQueued = c.messageQueue.clearPending(id);
    if (clearedQueued > 0) c.log.info("interrupt cleared queued messages", { workerId: id, count: clearedQueued });
    // Esc abandons this worker's outstanding peer consultations too — its blocked
    // ask_peer (if any) unblocks "gone"; in-flight asks to it decline.
    c.pendingPeerRequests.cancelByWorker(id);
    c.turnSettle.mark(id);
    session.interrupt().catch(() => {});
    transitionState(
      { workers: c.workers, events: c.events, bus: c.bus, clock: c.clock },
      { workerId: id, next: "IDLE", reason: "interrupt" },
    );
    c.bus.publish("worker:change", { workerId: id });
    return { status: 200, body: { ok: true } };
  },
};
