// DispatchMessage — proxies a user-typed message to a worker's PTY.
// Sets the worker's state to WORKING eagerly so the UI shows activity even
// before the first hook event fires.
//
// The user_message chat event is NOT appended here for backends that report
// it themselves (reportsMessageEvents): a dispatch-time append races the
// previous turn's trailing transcript JSONL and gets durably ordered above
// the agent's final output. The claude-cli worker emits it when the text
// lands in the transcript — the only true conversation order.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { WorkerClient } from "../ports/WorkerClient.ts";
import type { AgentBackendRegistry } from "../ports/AgentBackend.ts";
import type { MessageQueueRepo } from "../ports/MessageQueueRepo.ts";
import type { Logger } from "../ports/Logger.ts";
import { NotFoundError, ConflictError, UnreachableError } from "../errors/index.ts";
import { transitionState } from "./TransitionState.ts";

// Same-text re-dispatch inside this window (for sends without a clientMsgId)
// appends a log-only duplicate_dispatch_suspected lifecycle event — the
// breadcrumb that makes a future "message keeps repeating" report diagnosable
// from the DB alone.
const DUPLICATE_TEXT_WINDOW_MS = 10_000;

export interface DispatchMessageDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  queue: MessageQueueRepo;
  client: WorkerClient;
  /** When injected, the message goes through the AgentBackend selected by the
   *  worker's backend_kind (so a port-less in-process backend works too). Absent
   *  → legacy client.sendMessage by port. Phase 1 kill switch. */
  backends?: AgentBackendRegistry;
  log: Logger;
  /** When true and the worker has no live supervised child, the use-case
   * throws ConflictError instead of forwarding. Used for orchestrators —
   * a dead orchestrator row should refuse messages cleanly. */
  isLive(workerId: string): boolean;
  /** True for orchestrator targets — used by the route to gate this
   * use-case (404 if the target isn't an orchestrator). */
  requireOrchestrator?: boolean;
  /** TurnSettleService.clear — called ONLY when a message actually dispatches
   * (a genuine new turn). An enqueue must NOT clear the settle window: that
   * would re-open the trailing-jsonl false-WORKING gate right when the drain
   * needs a stable IDLE, starving the queue. */
  clearTurnSettle?(workerId: string): void;
  excerptLimit?: number;
}

export interface DispatchMessageInput {
  workerId: string;
  text: string;
  /** When set, the user_message event (what the chat renders) carries this
   * short label instead of the full text sent to the PTY. Used by predefined
   * actions whose prompt templates should stay out of the UI. */
  displayText?: string;
  /** Client-generated idempotency key. A second dispatch carrying an
   * already-seen id is a silent no-op ({deduped:true}) — a duplicate POST
   * can never become a second turn. */
  clientMsgId?: string;
  /** Dashboard semantics: if the worker is mid-turn (WORKING), hold the
   * message in the daemon queue and deliver at the next IDLE instead of
   * steering. Omitted (MCP/action paths) → direct dispatch as before. */
  queueWhenBusy?: boolean;
  /** Queue drain only: the clientMsgIds of the drained rows, carried in the
   * record so the web reconciles its optimistic bubbles by id. The drain
   * tracks these rows itself — they are NOT re-claimed here. */
  recordClientMsgIds?: string[];
  /** Where this dispatch came from (composer/action/mcp/queue-drain) — log +
   * forensics only. */
  origin?: string;
}

export async function dispatchMessage(
  deps: DispatchMessageDeps,
  input: DispatchMessageInput,
): Promise<{ status: number; body: unknown }> {
  const w = deps.workers.findById(input.workerId);
  if (!w) throw new NotFoundError("worker", input.workerId);
  if (deps.requireOrchestrator && !w.is_orchestrator) {
    throw new NotFoundError("orchestrator", input.workerId);
  }
  if (deps.requireOrchestrator && !deps.isLive(input.workerId)) {
    throw new ConflictError("orchestrator process not running (was killed)");
  }
  const kind = w.backend_kind ?? "claude-cli";
  const isInproc = kind !== "claude-cli";
  if (!isInproc && !w.port) throw new ConflictError("worker has no port");
  const backend = deps.backends?.has(kind) ? deps.backends.get(kind) : undefined;

  const now = deps.clock.now();

  // Dashboard sends hold here while a turn is running and dispatch at the
  // next IDLE (DrainQueuedMessages). Two cases queue:
  //   WORKING        — a turn is running.
  //   IDLE + backlog — pending rows exist; a direct dispatch would OVERTAKE
  //                    them (observed live: a send landing in the Stop→drain
  //                    window raced the drain and reached the PTY first, and
  //                    both then delivered interleaved). Enqueueing instead
  //                    lets the drain ship everything as one ordered dispatch
  //                    (the queued:true signal below triggers it immediately).
  // SPAWNING never queues — the worker-side readiness gate buffers pre-boot
  // writes, and gating on SPAWNING would deadlock resumed sessions that only
  // reach IDLE through a turn (with queued rows, nothing would start one).
  const state = String(w.state).toUpperCase();
  const hasBacklog = (): boolean => deps.queue.listPending(input.workerId).length > 0;
  if (input.queueWhenBusy && (state === "WORKING" || (state === "IDLE" && hasBacklog()))) {
    const queueId = deps.queue.insert({
      workerId: input.workerId,
      clientMsgId: input.clientMsgId ?? null,
      text: input.text,
      createdAt: now,
      dispatchedAt: null,
    });
    if (queueId === null) return { status: 200, body: { ok: true, deduped: true } };
    deps.log.info("message queued (worker busy)", { workerId: input.workerId, queueId, origin: input.origin });
    // queued:true doubles as a drain trigger — it closes the enqueue/IDLE race
    // (turn ended between the busy check and the insert → no future IDLE
    // transition would ever fire for this row).
    deps.bus.publish("worker:change", { workerId: input.workerId, queued: true });
    return { status: 202, body: { ok: true, queued: true, queueId } };
  }

  // Idempotency claim — inserted BEFORE the send so two concurrent POSTs with
  // the same id cannot both pass the check while the first one is awaiting the
  // worker. Rolled back on dispatch failure so a retry is not falsely deduped.
  let claimId: number | null = null;
  if (input.clientMsgId) {
    claimId = deps.queue.insert({
      workerId: input.workerId,
      clientMsgId: input.clientMsgId,
      text: input.text,
      createdAt: now,
      dispatchedAt: now,
    });
    if (claimId === null) {
      deps.log.info("duplicate clientMsgId — dispatch skipped", { workerId: input.workerId, clientMsgId: input.clientMsgId, origin: input.origin });
      return { status: 200, body: { ok: true, deduped: true } };
    }
  } else if (deps.queue.hasRecentDispatch(input.workerId, input.text, now - DUPLICATE_TEXT_WINDOW_MS)) {
    // Unkeyed send repeating the exact text of a just-dispatched message —
    // can't be safely dropped (no id), but leave the forensic breadcrumb.
    deps.events.append(input.workerId, now, "lifecycle", {
      phase: "duplicate_dispatch_suspected",
      text: input.text.slice(0, deps.excerptLimit ?? 500),
      origin: input.origin,
    });
    deps.log.warn("duplicate dispatch suspected (same text within window)", { workerId: input.workerId, origin: input.origin });
  }

  const recordClientMsgIds = input.recordClientMsgIds
    ?? (input.clientMsgId ? [input.clientMsgId] : undefined);
  const record = {
    as: "user_message" as const,
    sentAt: now,
    ...(input.displayText ? { displayText: input.displayText } : {}),
    ...(recordClientMsgIds && recordClientMsgIds.length > 0 ? { clientMsgIds: recordClientMsgIds } : {}),
  };

  const rollbackClaim = (): void => {
    if (claimId !== null) deps.queue.removeById(claimId);
  };

  // A real dispatch starts a genuine new turn — the settle window must not
  // suppress its WORKING lift or its first transcript events.
  deps.clearTurnSettle?.(input.workerId);

  let result;
  let selfReports: boolean;
  try {
    if (backend) {
      const handle = isInproc
        ? { kind: "inproc" as const, ref: w.id }
        : { kind: "http" as const, port: w.port as number, pid: w.pid ?? null };
      const session = backend.attach(w.id, handle);
      selfReports = session.capabilities.reportsMessageEvents === true;
      result = await session.sendMessage(input.text, selfReports ? record : undefined);
    } else {
      // Legacy port path drives a claude-cli PTY worker — it self-reports.
      if (!w.port) throw new ConflictError("worker has no port");
      selfReports = true;
      result = await deps.client.sendMessage(w.port, input.text, record);
    }
  } catch (e) {
    rollbackClaim();
    throw new UnreachableError("worker", e);
  }

  // HttpWorkerClient swallows connection errors into {ok:false, status:0} —
  // surface them instead of recording a user_message that never landed (and
  // writeJson(res, 0, …) would throw anyway).
  if (!result.ok && result.status === 0) {
    rollbackClaim();
    throw new UnreachableError("worker", new Error("worker connection failed"));
  }

  // Unkeyed dispatches leave a ledger row too — it powers hasRecentDispatch
  // and doubles as the dispatch audit trail (pruned on daemon startup).
  if (!input.clientMsgId) {
    deps.queue.insert({
      workerId: input.workerId,
      clientMsgId: null,
      text: input.text,
      createdAt: now,
      dispatchedAt: now,
    });
  }

  if (!selfReports) {
    deps.events.append(input.workerId, deps.clock.now(), "user_message", {
      text: input.displayText ?? input.text,
      ...(recordClientMsgIds && recordClientMsgIds.length > 0 ? { clientMsgIds: recordClientMsgIds } : {}),
    });
  }
  deps.bus.publish("worker:change", { workerId: input.workerId });

  // Eager state lift — same rationale as the old daemon code: a new turn is
  // starting and the worker should look WORKING right away.
  transitionState(
    { workers: deps.workers, events: deps.events, bus: deps.bus, clock: deps.clock },
    { workerId: input.workerId, next: "WORKING", reason: "user_message" },
  );

  return { status: result.status, body: result.body };
}
