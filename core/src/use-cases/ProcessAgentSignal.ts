// ProcessAgentSignal — drives the worker state machine from canonical,
// backend-agnostic AgentEvents (contracts/src/canonical.ts). It is the successor
// to ProcessWorkerEvent's Claude-specific hook/jsonl/heartbeat handlers and
// reuses the same building blocks (transitionState, the settle window,
// computeCostUsd) so its behavior matches the legacy path exactly.
//
// NOT yet wired into the daemon route — the Phase 0 flip (ADR 0001) activates it
// once every backend adapter emits canonical events. Until then it is exercised
// only by unit tests, so introducing it changes no runtime behavior.

import type { AgentEvent, ContentBlock } from "../../../contracts/src/canonical.ts";
import type { ProcessWorkerEventDeps } from "./ProcessWorkerEvent.ts";
import { transitionState } from "./TransitionState.ts";
import { logEvent } from "./LogEvent.ts";
import { computeCostUsd } from "../domain/value-objects.ts";

// SPAWNING always heals on activity (boot); IDLE heals only when NOT settling —
// an IDLE reached via a just-ended turn must stay put (trailing transcript), but
// an IDLE from prompt_unacknowledged should recover. Mirrors the legacy jsonl
// handler's canRecover guard.
function canRecover(deps: ProcessWorkerEventDeps, workerId: string): boolean {
  const cur = deps.workers.findById(workerId);
  return cur?.state === "SPAWNING" || (cur?.state === "IDLE" && !deps.isSettling?.(workerId));
}

function handleBlock(deps: ProcessWorkerEventDeps, workerId: string, block: ContentBlock): void {
  if (block.type === "tool_call") {
    // Mirror legacy jsonl:tool_use — count unconditionally (even when the
    // WORKING re-flip is suppressed by the settle window), heal if recoverable.
    deps.workers.incrementToolCalls(workerId);
    if (canRecover(deps, workerId)) {
      transitionState(deps, { workerId, next: "WORKING", reason: "agent:tool_call" });
    }
  } else if (block.type === "text" || block.type === "reasoning") {
    if (canRecover(deps, workerId)) {
      transitionState(deps, { workerId, next: "WORKING", reason: `agent:${block.type}` });
    }
  }
  // tool_result blocks never drive state (mirror legacy jsonl:tool_result).
}

// State-only reducer: drives the worker FSM from a canonical AgentEvent without
// logging it. Used by the Phase 0 daemon flip, where the legacy event is already
// logged and only its state effect is re-expressed canonically.
export function reduceAgentSignal(
  deps: ProcessWorkerEventDeps,
  workerId: string,
  event: AgentEvent,
): void {
  switch (event.type) {
    case "message":
      for (const block of event.blocks) handleBlock(deps, workerId, block);
      return;

    case "turn":
      if (event.phase === "started") {
        if (canRecover(deps, workerId)) {
          transitionState(deps, { workerId, next: "WORKING", reason: "agent:turn_started" });
        }
      } else if (event.phase === "ended") {
        // Open the settle window before going IDLE so trailing events of the
        // finished turn don't re-animate the worker (mirror hook:Stop).
        deps.markSettling?.(workerId);
        transitionState(deps, { workerId, next: "IDLE", reason: "agent:turn_ended" });
      } else if (event.phase === "aborted" || event.phase === "error") {
        deps.markSettling?.(workerId);
        transitionState(deps, { workerId, next: "IDLE", reason: `agent:turn_${event.phase}` });
      }
      return;

    case "activity":
      if (event.kind === "tool_finished") {
        if (deps.isSettling?.(workerId)) return;
        transitionState(deps, { workerId, next: "WORKING", reason: "agent:tool_finished" });
      } else if (event.kind === "alive") {
        if (deps.isSettling?.(workerId)) return;
        const cur = deps.workers.findById(workerId);
        if (cur && (cur.state === "SPAWNING" || cur.state === "IDLE")) {
          transitionState(deps, { workerId, next: "WORKING", reason: "agent:alive" });
        }
      }
      // tool_started never drives state (mirror legacy PreToolUse / tool_running).
      return;

    case "session":
      if (event.phase === "ended") {
        transitionState(deps, { workerId, next: "ENDING", reason: "agent:session_ended" });
      } else if (event.phase === "lost") {
        const cur = deps.workers.findById(workerId);
        if (cur && (cur.state === "SPAWNING" || cur.state === "WORKING")) {
          transitionState(deps, { workerId, next: "IDLE", reason: event.reason ?? "prompt_lost" });
        }
      }
      // started / ready carry no state transition here (explicit "state" events
      // still handle boot IDLE; worktreeDir enrichment stays on the legacy path).
      return;

    // usage / permission_request / question_request drive no state transition.
    default:
      return;
  }
}

// Full canonical entry point: logs the agent_event, then drives state + cost.
// Used when a backend adapter emits canonical events directly (Phase 1+). The
// Phase 0 daemon flip instead logs the legacy event and calls reduceAgentSignal.
export function processAgentSignal(
  deps: ProcessWorkerEventDeps,
  workerId: string,
  event: AgentEvent,
): void {
  const rowId = logEvent(deps, workerId, "agent_event", event);
  if (event.type === "usage") {
    handleUsage(deps, workerId, event, rowId);
    return;
  }
  reduceAgentSignal(deps, workerId, event);
}

function handleUsage(
  deps: ProcessWorkerEventDeps,
  workerId: string,
  event: Extract<AgentEvent, { type: "usage" }>,
  rowId: number,
): void {
  const u = event.usage;
  const row = deps.workers.findById(workerId);
  let model = u.model ?? row?.model;
  if (!model) {
    deps.log.warn("usage event missing model — falling back to opus pricing", { workerId });
    model = "opus";
  }
  const tokens = {
    in: u.inputTokens,
    out: u.outputTokens,
    cacheRead: u.cacheReadTokens ?? 0,
    cacheCreate: u.cacheWriteTokens?.["5m"] ?? 0,
    cacheCreate1h: u.cacheWriteTokens?.["1h"] ?? 0,
  };
  let deltaCost = computeCostUsd(deps.models, model, tokens);
  if (!Number.isFinite(deltaCost) || deltaCost < 0) {
    deps.log.error("computed deltaCost is invalid — recording as 0", { workerId, model, deltaCost });
    deltaCost = 0;
  }
  deps.workers.addUsage(workerId, { ...tokens, costUsd: deltaCost });
  // Back-fill deltaCost into the just-logged agent_event so /session can sum it
  // without re-pricing per model (mirror the legacy usage handler).
  deps.events.patchPayload(rowId, { ...u, deltaCost });
  deps.bus.publish("usage:recorded", { workerId, deltaCost });
}
