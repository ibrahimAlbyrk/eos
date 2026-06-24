import type { CommandHandler } from "../pipeline.ts";
import {
  interruptWorkerCommand,
  type WorkerIdAddr,
  type InterruptWorkerResponse,
} from "../../../contracts/src/commands/defs.ts";
import type { NoBody } from "../../../contracts/src/commands/types.ts";
import { transitionState } from "../../../core/src/use-cases/TransitionState.ts";
import { recallPendingTurn } from "../../../core/src/use-cases/RecallPendingTurn.ts";
import { appendSynthesized } from "../../shared/synthesized-events.ts";

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
    // Esc cancels what the USER queued — clear BEFORE the IDLE transition or the
    // drain would fire the queued steers the interrupt meant to stop. Scoped to
    // the user plane so agent-plane reports (loop feedback, peer requests) the
    // system must still deliver survive and drain on the next IDLE.
    const clearedQueued = c.messageQueue.clearPendingUserPlane(id);
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

    // Recall: interrupt before the agent responded. Only on a lane where the
    // daemon owns the user_message row (!reportsMessageEvents — the SDK lane),
    // never on kind: claude-cli self-reports from its JSONL and has its own
    // keystroke/rewind choreography. If the turn produced no output, hide the
    // just-sent bubble, drop its ledger row, return its text to the composer
    // (UI), and roll back the SDK's own transcript. The handler only emits +
    // shapes — the decision is the use-case's (mirrors the rewind route).
    if (!session.capabilities.reportsMessageEvents) {
      const recall = recallPendingTurn(
        { events: c.events, queue: c.messageQueue, turnOutput: c.turnOutput },
        id,
      );
      if (recall.recalled) {
        appendSynthesized(c, id, "message_recalled", {
          text: recall.text,
          ...(recall.clientMsgId ? { clientMsgId: recall.clientMsgId } : {}),
          recalledRowId: recall.rowId,
        });
        // Push the text + key so the UI restores the composer + retracts the
        // optimistic bubble immediately (the durable event hides the server-side
        // bubble; this drives the ephemeral client-side restore — raceless).
        c.bus.publish("message:recalled", {
          workerId: id,
          text: recall.text,
          ...(recall.clientMsgId ? { clientMsgId: recall.clientMsgId } : {}),
        });
        // Layer 2 — roll back the SDK's own session transcript so the recalled
        // message leaks into neither the next turn nor a resume. Capability gate
        // is the optional method's presence (SDK implements it; others omit it).
        // Best-effort: a fork failure must not fail the interrupt.
        if (session.recallLastUserTurn) void session.recallLastUserTurn().catch(() => {});
      }
    }

    return { status: 200, body: { ok: true } };
  },
};
