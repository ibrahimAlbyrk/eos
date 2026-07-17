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
import type { TurnOutputTracker } from "../ports/TurnOutputTracker.ts";
import type { Logger } from "../ports/Logger.ts";
import type { MessageRecord } from "../../../contracts/src/http.ts";
import type { DispatchEnvelope } from "../domain/message-envelope.ts";
import { applySenderTag, senderTagForEnvelope } from "../domain/sender-tag.ts";
import type { SlashCommandRegistry, SlashSideEffects } from "../domain/slash-command.ts";
import { parseSlash } from "../domain/slash-command.ts";
import { NotFoundError, ConflictError, UnreachableError } from "../errors/index.ts";
import { transitionState } from "./TransitionState.ts";

export type { DispatchEnvelope };

// Same-text re-dispatch inside this window (for sends without a clientMsgId)
// appends a log-only duplicate_dispatch_suspected lifecycle event — the
// breadcrumb that makes a future "message keeps repeating" report diagnosable
// from the DB alone.
const DUPLICATE_TEXT_WINDOW_MS = 10_000;

// The chat-event kind is data, not a code path: agent-plane callers (worker
// report, orchestrator directive, peer request) pass a DispatchEnvelope so they
// reuse this one backend-aware, queue-serialized delivery instead of bespoke
// httpWorkerClient.sendMessage calls. Absent → a plain user_message.
function buildMessageRecord(
  env: DispatchEnvelope | undefined,
  sentAt: number,
  displayText: string | undefined,
  clientMsgIds: string[] | undefined,
): MessageRecord {
  const display = displayText ? { displayText } : {};
  switch (env?.kind) {
    case "orchestrator_message":
      return { as: "orchestrator_message", fromParent: env.fromParent, ...(env.parentName ? { parentName: env.parentName } : {}), ...display, sentAt };
    case "worker_report":
      return { as: "worker_report", fromWorker: env.fromWorker, ...(env.workerName ? { workerName: env.workerName } : {}), ...display, sentAt };
    case "peer_request":
      return { as: "peer_request", fromWorker: env.fromWorker, ...(env.fromName ? { fromName: env.fromName } : {}), ...display, sentAt };
    case "loop":
      return { as: "loop_continuation", ...display, sentAt };
    case "report_reminder":
      return { as: "report_reminder", ...display, sentAt };
    case "permission_ask":
      return { as: "permission_ask", ...display, sentAt };
    default:
      return { as: "user_message", ...display, ...(clientMsgIds && clientMsgIds.length > 0 ? { clientMsgIds } : {}), sentAt };
  }
}

// Daemon-side chat event for backends that do NOT self-report (in-process:
// claude-sdk/anthropic-api). Mirrors EXACTLY the shapes the PTY worker emits at
// its transcript sighting (spawner/worker.ts emitMessageEvent) so the web
// renders agent-plane traffic identically across backends.
//
// Returns the appended row id ONLY for a plain user_message — the recall target
// an interrupt may hide (RecallPendingTurn). Agent-plane kinds return null:
// their turns must never recall anything.
function appendChatEvent(
  events: EventRepo,
  workerId: string,
  ts: number,
  env: DispatchEnvelope | undefined,
  text: string,
  clientMsgIds: string[] | undefined,
): number | null {
  switch (env?.kind) {
    case "orchestrator_message":
      events.append(workerId, ts, "orchestrator_message", { text, fromParent: env.fromParent, parentName: env.parentName ?? env.fromParent });
      return null;
    case "worker_report":
      events.append(workerId, ts, "worker_report", { text, fromWorker: env.fromWorker, workerName: env.workerName ?? env.fromWorker });
      return null;
    case "peer_request":
      events.append(workerId, ts, "peer_request", { text, fromWorker: env.fromWorker, fromName: env.fromName ?? env.fromWorker });
      return null;
    case "loop":
      events.append(workerId, ts, "loop_continuation", { text });
      return null;
    case "report_reminder":
      events.append(workerId, ts, "report_reminder", { text });
      return null;
    case "permission_ask":
      events.append(workerId, ts, "permission_ask", { text });
      return null;
    default:
      return events.append(workerId, ts, "user_message", { text, ...(clientMsgIds && clientMsgIds.length > 0 ? { clientMsgIds } : {}) });
  }
}

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
  /** Slash-command allowlist. When present (with a resolved backend), an exact,
   *  argument-complete, capable command short-circuits the normal turn and runs
   *  as a control side effect. Absent → no interception (legacy/tests). */
  slashCommands?: SlashCommandRegistry;
  /** Daemon-side seams a slash command may touch (queue clear, peer cancel,
   *  conversation_cleared). Required for interception to fire. */
  slashEffects?: SlashSideEffects;
  /** Prompt-template (`.md` slash-command) expander (§5c). Invoked ONLY when the
   *  resolved backend does NOT expand templates natively
   *  (descriptor.capabilities.expandsSlashTemplates !== true — the in-process lane):
   *  given the raw text + the worker's cwd, it discovers a matching `.md` command and
   *  returns the expanded text, or null when the text is not a discovered template
   *  command. Absent → no Eos-side expansion (the claude lanes self-expand). Gated on
   *  the capability, never on backend kind. */
  expandTemplate?(text: string, cwd: string | null): Promise<string | null>;
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
  /** Reset the worker's turn-output signal at the dispatch push (a genuine new
   *  turn): the recall window for this message scopes from HERE, not turn:started
   *  (which fires after the first token). Read later by RecallPendingTurn. */
  turnOutput?: TurnOutputTracker;
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
  /** Message kind + routing metadata. Absent → a plain user_message. Set by
   * the agent plane (report/directive/peer) so it shares this backend-aware,
   * queue-serialized delivery. The record (PTY self-report) and the daemon-side
   * chat event (in-process) are both derived from it. */
  envelope?: DispatchEnvelope;
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
  const backend = deps.backends?.has(kind) ? deps.backends.get(kind) : undefined;
  const isInproc = backend?.descriptor.processModel === "in-process";
  if (!isInproc && !w.port) throw new ConflictError("worker has no port");

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
      // An envelope means agent-plane traffic (report/directive/peer): tag the
      // plane so the pill endpoint hides it. The row still drains into the
      // transcript at the parent's next IDLE — it just never shows as a user
      // pill while the parent is mid-turn.
      plane: input.envelope ? "agent" : "user",
      // Agent-plane routing rides the pending row so the drain replays a report
      // as a worker_report (not a plain user_message showing the wrapper).
      ...(input.envelope ? { envelope: input.envelope } : {}),
      ...(input.displayText ? { displayText: input.displayText } : {}),
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

  // Slash-command interception — the chokepoint shared by the live route AND the
  // queue drain (both call this function), so a /clear queued while WORKING is
  // still run as a command when it drains. Placed AFTER the idempotency claim so
  // a duplicate /clear dedups like any message, and BEFORE the record build /
  // backend send so a command produces NO user_message chat event. An unknown,
  // partial, or incapable command (parseSlash null / accepts false) falls through
  // to a normal turn — the registry is an allowlist, never a swallow-all.
  if (deps.slashCommands && deps.slashEffects && backend) {
    const slash = parseSlash(input.text, deps.slashCommands);
    if (slash) {
      let session;
      try {
        const handle = isInproc
          ? { kind: "inproc" as const, ref: w.id }
          : { kind: "http" as const, port: w.port as number, pid: w.pid ?? null };
        session = backend.attach(w.id, handle);
      } catch (e) {
        if (claimId !== null) deps.queue.removeById(claimId);
        throw new UnreachableError("worker", e);
      }
      if (slash.command.accepts(slash.args, session.capabilities)) {
        // A command is a genuine state change — clear the settle window so the
        // post-clear events aren't suppressed. No WORKING lift (not a turn).
        deps.clearTurnSettle?.(input.workerId);
        const result = await slash.command.execute({
          workerId: w.id,
          args: slash.args,
          session,
          caps: session.capabilities,
          services: deps.slashEffects,
        });
        deps.bus.publish("worker:change", { workerId: w.id });
        return result;
      }
    }
  }

  // Prompt-template expansion (§5c) — only when the backend does NOT expand `.md`
  // slash-commands natively. Placed AFTER control-command interception (those
  // returned early) and BEFORE the turn dispatch, so a discovered template's
  // expanded text becomes the model's user message. The chat event keeps the typed
  // `/command` (below); only the text sent to the model is the expansion. A failed
  // expansion never sinks the turn — it falls through to the raw text.
  let outgoing = input.text;
  if (backend && deps.expandTemplate && backend.descriptor.capabilities.expandsSlashTemplates !== true) {
    try {
      const expanded = await deps.expandTemplate(input.text, w.worktree_dir ?? w.cwd ?? null);
      if (expanded !== null) outgoing = expanded;
    } catch (e) {
      deps.log.warn("slash-template expansion failed", { workerId: w.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Sender tag — the ONE upstream chokepoint (the other is SpawnWorker's boot
  // prompt). Wrap the model-visible text in its <agent_message>/<system_message>
  // wrapper AFTER template expansion and BEFORE either lane sends it, so the
  // model can tell operator (untagged) from agent from system. Both lanes pass
  // `outgoing` verbatim; the chat still renders the bare body (record.displayText
  // / the daemon-side append below), so the tag never reaches the UI. An operator
  // dispatch (no envelope) leaves outgoing untagged.
  const tag = senderTagForEnvelope(input.envelope);
  if (tag) outgoing = applySenderTag(outgoing, tag.cls, tag.attrs);

  const recordClientMsgIds = input.recordClientMsgIds
    ?? (input.clientMsgId ? [input.clientMsgId] : undefined);
  const record = buildMessageRecord(input.envelope, now, input.displayText, recordClientMsgIds);

  const rollbackClaim = (): void => {
    if (claimId !== null) deps.queue.removeById(claimId);
  };

  // A real dispatch starts a genuine new turn — the settle window must not
  // suppress its WORKING lift or its first transcript events.
  deps.clearTurnSettle?.(input.workerId);
  // Scope the recall window from this push: clears seen AND the previous turn's
  // recall target, so an interrupt can never recall an older, answered message.
  // This turn's own target is attached after the append below (user dispatches
  // only) — the row id doesn't exist yet, and a failed send must leave nothing
  // recallable.
  deps.turnOutput?.reset(input.workerId);

  let result;
  let selfReports: boolean;
  try {
    if (backend) {
      const handle = isInproc
        ? { kind: "inproc" as const, ref: w.id }
        : { kind: "http" as const, port: w.port as number, pid: w.pid ?? null };
      const session = backend.attach(w.id, handle);
      selfReports = session.capabilities.reportsMessageEvents === true;
      result = await session.sendMessage(outgoing, selfReports ? record : undefined);
    } else {
      // Legacy port path drives a claude-cli PTY worker — it self-reports.
      if (!w.port) throw new ConflictError("worker has no port");
      selfReports = true;
      result = await deps.client.sendMessage(w.port, outgoing, record);
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
  // Carry the plane from the envelope (same rule as the busy-hold above): an
  // agent-plane dispatch (worker_report/directive/peer) must NOT leave a
  // plane-blind row that defaults to 'user' — that surfaced every report as a
  // second user-plane copy of itself (a phantom user pill).
  //
  // SKIP on a queue drain: the drained row IS the dispatch (DrainQueuedMessages
  // markDispatches it right after this returns), so it already serves as the
  // audit record + powers hasRecentDispatch. A second ledger row here is pure
  // duplication (both NULL client_msg_id → the unique index never dedups them),
  // which is exactly how one report became two queued_messages rows.
  if (!input.clientMsgId && input.origin !== "queue-drain") {
    deps.queue.insert({
      workerId: input.workerId,
      clientMsgId: null,
      text: input.text,
      createdAt: now,
      dispatchedAt: now,
      plane: input.envelope ? "agent" : "user",
    });
  }

  if (!selfReports) {
    const chatRowId = appendChatEvent(deps.events, input.workerId, deps.clock.now(), input.envelope, input.displayText ?? input.text, recordClientMsgIds);
    // The recall target for this turn: exactly the user_message row just
    // appended. The !seen gate covers the send→append microtask gap.
    if (chatRowId != null) deps.turnOutput?.setRecallRow(input.workerId, chatRowId);
  }
  deps.bus.publish("worker:change", { workerId: input.workerId });

  // Eager state lift — same rationale as the old daemon code: a new turn is
  // starting and the worker should look WORKING right away.
  transitionState(
    { workers: deps.workers, events: deps.events, bus: deps.bus, clock: deps.clock },
    { workerId: input.workerId, next: "WORKING", reason: input.envelope?.kind ?? "user_message" },
  );

  return { status: result.status, body: result.body };
}
