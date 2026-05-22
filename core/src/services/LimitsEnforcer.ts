// LimitsEnforcer — per-worker cost/elapsed budgets. Sweeps periodically and
// also re-checks immediately after every usage event (driven by
// ProcessWorkerEvent's onUsageRecorded hook).
//
// Once a cap is crossed: emits `limit_exceeded` event, transitions worker
// to KILLING, sends SIGTERM (escalated by the supervisor). The actual SIGKILL
// fallback is the supervisor's responsibility.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { ProcessSupervisor } from "../ports/ProcessSupervisor.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import { transitionState } from "../use-cases/TransitionState.ts";

export interface WorkerLimits {
  maxCostUsd?: number;
  maxElapsedMs?: number;
}

export interface LimitsEnforcerDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  supervisor: ProcessSupervisor;
  clock: Clock;
  log: Logger;
}

export class LimitsEnforcer {
  private cache = new Map<string, WorkerLimits>();
  private readonly deps: LimitsEnforcerDeps;

  constructor(deps: LimitsEnforcerDeps) {
    this.deps = deps;
  }

  set(workerId: string, limits: WorkerLimits): void {
    this.cache.set(workerId, limits);
  }
  clear(workerId: string): void {
    this.cache.delete(workerId);
  }

  /** Probe `workerId` against its cached limits. Called from periodic sweep
   * and from the usage event path. Cheap when the worker has no limits. */
  check(workerId: string): void {
    const limits = this.cache.get(workerId);
    if (!limits) return;
    const row = this.deps.workers.findById(workerId);
    if (!row || row.state === "DONE" || row.state === "KILLING") return;

    let exceeded: { kind: "cost" | "elapsed"; value: number; limit: number } | null = null;
    if (limits.maxCostUsd != null && (row.cost_usd ?? 0) > limits.maxCostUsd) {
      exceeded = { kind: "cost", value: row.cost_usd ?? 0, limit: limits.maxCostUsd };
    } else if (limits.maxElapsedMs != null) {
      const elapsed = this.deps.clock.now() - row.started_at;
      if (elapsed > limits.maxElapsedMs) {
        exceeded = { kind: "elapsed", value: elapsed, limit: limits.maxElapsedMs };
      }
    }
    if (!exceeded) return;

    this.deps.events.append(workerId, this.deps.clock.now(), "limit_exceeded", exceeded);
    this.deps.bus.publish("limit:exceeded", { workerId, ...exceeded });
    this.deps.log.warn("worker over limit, killing", { worker: workerId, ...exceeded });
    transitionState(
      { workers: this.deps.workers, events: this.deps.events, bus: this.deps.bus, clock: this.deps.clock },
      { workerId, next: "KILLING", reason: `limit_exceeded:${exceeded.kind}` },
    );
    this.cache.delete(workerId);
    this.deps.supervisor.escalateKill(workerId);
  }

  /** Walk every tracked worker. Called by the periodic 30s timer. */
  sweep(): void {
    for (const id of this.cache.keys()) this.check(id);
  }
}
