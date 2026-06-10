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
import type { Logger } from "../ports/Logger.ts";
import { NotFoundError, ConflictError, UnreachableError } from "../errors/index.ts";
import { transitionState } from "./TransitionState.ts";

export interface DispatchMessageDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
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
  excerptLimit?: number;
}

export interface DispatchMessageInput {
  workerId: string;
  text: string;
  /** When set, the user_message event (what the chat renders) carries this
   * short label instead of the full text sent to the PTY. Used by predefined
   * actions whose prompt templates should stay out of the UI. */
  displayText?: string;
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

  const record = {
    as: "user_message" as const,
    ...(input.displayText ? { displayText: input.displayText } : {}),
  };

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
    throw new UnreachableError("worker", e);
  }

  // HttpWorkerClient swallows connection errors into {ok:false, status:0} —
  // surface them instead of recording a user_message that never landed (and
  // writeJson(res, 0, …) would throw anyway).
  if (!result.ok && result.status === 0) {
    throw new UnreachableError("worker", new Error("worker connection failed"));
  }

  if (!selfReports) {
    deps.events.append(input.workerId, deps.clock.now(), "user_message", {
      text: input.displayText ?? input.text,
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
