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
import { computeCostUsd } from "../domain/value-objects.ts";
import { reduceAgentSignal } from "./ProcessAgentSignal.ts";
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
  hook(deps, input) {
    const evt = (input.payload as { event?: string })?.event;
    if (evt === "PostToolUse" || evt === "PostToolUseFailure") {
      if (deps.isSettling?.(input.workerId)) return;
      transitionState(deps, { workerId: input.workerId, next: "WORKING", reason: `hook:${evt}` });
    } else if (evt === "Stop") {
      // Turn ended. Open the settle window before going IDLE so trailing
      // transcript JSONL (which can arrive after this Stop via the unordered
      // event channel) does not re-animate the worker back to WORKING.
      deps.markSettling?.(input.workerId);
      transitionState(deps, { workerId: input.workerId, next: "IDLE", reason: "hook:Stop" });
    } else if (evt === "SessionEnd") {
      transitionState(deps, { workerId: input.workerId, next: "ENDING", reason: "hook:SessionEnd" });
    }
  },
  jsonl(deps, input) {
    const kind = (input.payload as { kind?: string })?.kind;
    if (kind === "assistant_text" || kind === "thinking" || kind === "tool_use") {
      const cur = deps.workers.findById(input.workerId);
      // SPAWNING always heals on first real JSONL (boot). IDLE heals only when
      // the worker is NOT settling: an IDLE reached via a just-ended turn
      // (Stop/interrupt) must stay put — the incoming JSONL is trailing
      // transcript of that finished turn, not a new one.
      const canRecover =
        cur?.state === "SPAWNING" ||
        (cur?.state === "IDLE" && !deps.isSettling?.(input.workerId));
      if (canRecover) {
        transitionState(deps, { workerId: input.workerId, next: "WORKING", reason: `jsonl:${kind}` });
      }
    }
    if (kind === "tool_use") {
      deps.workers.incrementToolCalls(input.workerId);
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
  heartbeat(deps, input) {
    if (deps.isSettling?.(input.workerId)) return;
    const cur = deps.workers.findById(input.workerId);
    if (cur && (cur.state === "SPAWNING" || cur.state === "IDLE")) {
      transitionState(deps, { workerId: input.workerId, next: "WORKING", reason: "heartbeat" });
    }
  },
  tool_running() {},
  usage(deps, input, rowId) {
    const u = (input.payload as {
      in?: number;
      out?: number;
      cacheRead?: number;
      cacheCreate?: number;
      cacheCreate1h?: number;
      model?: string;
    }) ?? {};
    const tIn = u.in ?? 0;
    const tOut = u.out ?? 0;
    const cRead = u.cacheRead ?? 0;
    const cCreate = u.cacheCreate ?? 0;
    const cCreate1h = u.cacheCreate1h ?? 0;

    const row = deps.workers.findById(input.workerId);
    let model = u.model ?? row?.model;
    if (!model) {
      // Falling back to opus over-estimates cost (highest tier). Logged so the
      // operator can find why model attribution was missing for this turn.
      deps.log.warn("usage event missing model — falling back to opus pricing", {
        workerId: input.workerId,
      });
      model = "opus";
    }
    let deltaCost = computeCostUsd(deps.models, model, { in: tIn, out: tOut, cacheRead: cRead, cacheCreate: cCreate, cacheCreate1h: cCreate1h });
    if (!Number.isFinite(deltaCost) || deltaCost < 0) {
      // Defensive: a malformed price catalog (e.g. partial override leaving
      // undefined fields) would yield NaN. Record 0 and surface the problem
      // instead of corrupting cumulative cost_usd.
      deps.log.error("computed deltaCost is invalid — recording as 0", {
        workerId: input.workerId, model, deltaCost,
      });
      deltaCost = 0;
    }

    deps.workers.addUsage(input.workerId, {
      in: tIn, out: tOut, cacheRead: cRead, cacheCreate: cCreate, cacheCreate1h: cCreate1h, costUsd: deltaCost,
    });
    // Back-fill deltaCost into the just-inserted payload so /session can
    // sum it without re-computing per model.
    deps.events.patchPayload(rowId, { ...u, deltaCost });
    deps.bus.publish("usage:recorded", { workerId: input.workerId, deltaCost });
  },
};

// Claude-transport events whose state effects are re-expressed canonically when
// a translator is injected. Everything else (state, usage, lifecycle, and the
// daemon-synthesized events) stays on its dedicated legacy handler.
const CANONICAL_DRIVEN = new Set<WorkerEventType>(["hook", "jsonl", "heartbeat"]);

export function processWorkerEvent(
  deps: ProcessWorkerEventDeps,
  input: WorkerEventInput,
): void {
  const type = input.type as WorkerEventType;
  const rowId = logEvent(deps, input.workerId, type, input.payload);
  if (deps.toCanonical && CANONICAL_DRIVEN.has(type)) {
    for (const ev of deps.toCanonical(type, input.payload)) {
      reduceAgentSignal(deps, input.workerId, ev);
    }
    return;
  }
  const handler = HANDLERS[type];
  if (handler) handler(deps, input, rowId);
}
