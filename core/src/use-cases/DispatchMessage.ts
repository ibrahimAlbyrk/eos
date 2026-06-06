// DispatchMessage — proxies a user-typed message to a worker's PTY.
// Sets the worker's state to WORKING eagerly so the UI shows activity even
// before the first hook event fires.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { WorkerClient } from "../ports/WorkerClient.ts";
import type { AgentBackend } from "../ports/AgentBackend.ts";
import type { Logger } from "../ports/Logger.ts";
import { NotFoundError, ConflictError, UnreachableError } from "../errors/index.ts";
import { transitionState } from "./TransitionState.ts";

export interface DispatchMessageDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  client: WorkerClient;
  /** When injected, the message goes through the AgentBackend session (so a
   *  port-less in-process backend works too). Absent → legacy client.sendMessage
   *  by port. Phase 1 kill switch. */
  backend?: AgentBackend;
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
  if (!w.port) throw new ConflictError("worker has no port");

  let result;
  try {
    if (deps.backend) {
      const session = deps.backend.attach(w.id, { kind: "http", port: w.port, pid: w.pid ?? null });
      result = await session.sendMessage(input.text);
    } else {
      result = await deps.client.sendMessage(w.port, input.text);
    }
  } catch (e) {
    throw new UnreachableError("worker", e);
  }

  deps.events.append(input.workerId, deps.clock.now(), "user_message", {
    text: input.text,
  });
  deps.bus.publish("worker:change", { workerId: input.workerId });

  // Eager state lift — same rationale as the old daemon code: a new turn is
  // starting and the worker should look WORKING right away.
  transitionState(
    { workers: deps.workers, events: deps.events, bus: deps.bus, clock: deps.clock },
    { workerId: input.workerId, next: "WORKING", reason: "user_message" },
  );

  return { status: result.status, body: result.body };
}
