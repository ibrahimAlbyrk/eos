// ProcessWorkerEvent — dispatches the 5-way POST /workers/:id/events switch
// (state, hook, jsonl, heartbeat, usage) onto specific handlers. Each event
// type implements WorkerEventHandler and is registered on construction.
// Adding a new event type means a new handler — no edits to the daemon
// route or to this dispatcher.

import type { WorkerEventType } from "../../../contracts/src/events.ts";
import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { ModelCatalog } from "../ports/ModelCatalog.ts";
import type { Logger } from "../ports/Logger.ts";
import { transitionState } from "./TransitionState.ts";
import { logEvent } from "./LogEvent.ts";
import { processAgentSignal } from "./ProcessAgentSignal.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

export interface ProcessWorkerEventDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  models: ModelCatalog;
  log: Logger;
  /** True while a worker is inside its post-turn settle window — suppresses
   *  heartbeat/hook/jsonl transitions that would re-flip a just-idled worker
   *  back to WORKING from trailing transcript of the finished turn. */
  isSettling?(workerId: string): boolean;
  /** Opens the settle window for a worker whose turn just ended (Stop hook). */
  markSettling?(workerId: string): void;
  /** When provided, hook/jsonl/heartbeat events are driven through the canonical
   *  pipeline (toCanonical → reduceAgentSignal) instead of the legacy handlers.
   *  Injected by the daemon composition root (the claude-cli adapter's
   *  translator); absent in unit tests, which exercise the legacy path. */
  toCanonical?(type: string, payload: unknown): AgentEvent[];
}

export interface WorkerEventInput {
  workerId: string;
  type: string;
  payload: unknown;
}

export type WorkerEventHandler = (
  deps: ProcessWorkerEventDeps,
  input: WorkerEventInput,
  rowId: number,
) => void;

const HANDLERS: Partial<Record<WorkerEventType, WorkerEventHandler>> = {
  state(deps, input) {
    const payload = input.payload as { state?: string } | null;
    const next = payload?.state;
    if (typeof next === "string") {
      transitionState(deps, {
        workerId: input.workerId,
        next: next.toUpperCase() as Parameters<typeof transitionState>[1]["next"],
        reason: "worker_pushed",
      });
    }
  },
  lifecycle(deps, input) {
    const p = input.payload as { phase?: string; worktreeDir?: unknown; forkBaseSha?: unknown; sessionId?: unknown } | null;
    const phase = p?.phase;
    if (phase === "claude_spawning") {
      // Enrichment only: persist the worker's resolved (realpath'd) worktree dir
      // so the daemon can remove it on delete even after the process is gone.
      // Raw string only — no path/fs math here (core stays Node-free).
      if (typeof p?.worktreeDir === "string" && p.worktreeDir.length > 0) {
        deps.workers.setWorktreeDir(input.workerId, p.worktreeDir);
      }
      if (typeof p?.forkBaseSha === "string" && p.forkBaseSha.length > 0) {
        deps.workers.setForkBaseSha(input.workerId, p.forkBaseSha);
      }
      // claude_spawning fires after setupWorktree (creation + hydration done),
      // so the workspace is materialized — unlock agent-scoped git reads.
      deps.workers.setWorkspaceReady(input.workerId);
    } else if (phase === "session_captured") {
      // Enrichment only: persist the claude session id so the conversation can
      // be resumed (`claude --resume`) after the process dies. Emitted on both
      // initial capture and session swap (/clear, fork).
      if (typeof p?.sessionId === "string" && p.sessionId.length > 0) {
        deps.workers.setSessionId(input.workerId, p.sessionId);
      }
    } else if (phase === "delivery_failed") {
      // The delivery pipeline gave up (no composer echo AND no transcript ACK
      // across every attempt) — the eager WORKING set on user_message is a lie;
      // heal back to IDLE so the failure is visible instead of a stuck spinner.
      transitionState(deps, { workerId: input.workerId, next: "IDLE", reason: "delivery_failed" });
    }
  },
};

// Claude-transport events whose content / cost / turn / liveness signals are
// persisted AND driven canonically (one row type: agent_event). Only the two
// genuinely claude-cli-private events keep a legacy handler + row: `state` (a
// direct backend-agnostic transition push) and `lifecycle` (worktree / session-id
// enrichment + the delivery_failed heal — none of which map to a canonical event).
const CANONICAL_PERSISTED = new Set<WorkerEventType>(["jsonl", "tool_running", "tool_done", "hook", "heartbeat", "usage"]);

export function processWorkerEvent(
  deps: ProcessWorkerEventDeps,
  input: WorkerEventInput,
): void {
  const type = input.type as WorkerEventType;
  if (deps.toCanonical && CANONICAL_PERSISTED.has(type)) {
    // Translate to canonical and persist as agent_event(s): processAgentSignal logs
    // the row, drives the state machine, and computes cost (usage). No legacy row.
    for (const ev of deps.toCanonical(type, input.payload)) {
      processAgentSignal(deps, input.workerId, ev);
    }
    return;
  }
  const rowId = logEvent(deps, input.workerId, type, input.payload);
  const handler = HANDLERS[type];
  if (handler) handler(deps, input, rowId);
}
