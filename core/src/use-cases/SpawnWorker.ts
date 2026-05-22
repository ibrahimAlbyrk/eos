// SpawnWorker — composes argv, allocates a port, asks the supervisor to
// spawn a child process, persists the new row, and emits a `spawn` event.
// Knows nothing about node:child_process, node-pty, or sqlite directly.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { ProcessSupervisor, PortAllocator } from "../ports/ProcessSupervisor.ts";
import type { Clock } from "../ports/Clock.ts";
import type { IdGenerator } from "../ports/IdGenerator.ts";
import type { Logger } from "../ports/Logger.ts";

export interface SpawnWorkerSpec {
  prompt: string;
  cwd?: string;
  worktreeFrom?: string;
  branch?: string;
  name?: string;
  withGateway?: boolean;
  persistent?: boolean;
  systemPromptFile?: string;
  mcpConfig?: string;
  permissionPromptTool?: string;
  claudePermissionMode?: string;
  fixedId?: string;
  parentId?: string;
  model?: string;
  isOrchestrator?: boolean;
  maxCostUsd?: number;
  maxElapsedMs?: number;
}

export interface SpawnWorkerDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  supervisor: ProcessSupervisor;
  ports: PortAllocator;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  /** Builds the argv array for the worker child process given identity +
   * spec. The composition root injects the real builder which knows the
   * worker script path. Keeps SpawnWorker free of any FS knowledge. */
  buildArgs(input: { id: string; port: number; spec: SpawnWorkerSpec; model: string }): string[];
  /** Builds the env map (the daemon-aware CLAUDE_MGR_* triplet + bin paths). */
  buildEnv(input: { id: string; spec: SpawnWorkerSpec }): Record<string, string>;
  /** Path where the supervisor should pipe the child's stdout/stderr. */
  logFileFor(id: string): string;
  /** Limit cache — wired up by the composition root to a service. Optional;
   * if absent, no limits are enforced. */
  onLimitsSet?(workerId: string, limits: { maxCostUsd?: number; maxElapsedMs?: number }): void;
}

export async function spawnWorker(
  deps: SpawnWorkerDeps,
  spec: SpawnWorkerSpec,
): Promise<{ id: string; port: number }> {
  const id = spec.fixedId ?? deps.ids.newWorkerId();
  const port = await deps.ports.allocate();
  const model = spec.model ?? "opus";

  const args = deps.buildArgs({ id, port, spec, model });
  const env = deps.buildEnv({ id, spec });
  const logFile = deps.logFileFor(id);

  const proc = deps.supervisor.spawn(id, {
    args,
    env,
    logFile,
    onExit: (code) => {
      const now = deps.clock.now();
      deps.workers.markDone(id, now, code);
      deps.events.append(id, now, "exit", { code });
      deps.bus.publish("worker:exit", { workerId: id, code });
      deps.ports.release(port);
    },
  });

  deps.workers.insert({
    id,
    prompt: spec.prompt,
    cwd: spec.cwd ?? null,
    worktreeFrom: spec.worktreeFrom ?? null,
    branch: spec.branch ?? null,
    name: spec.name ?? null,
    pid: proc.pid,
    port,
    startedAt: deps.clock.now(),
    parentId: spec.parentId ?? null,
    model,
    isOrchestrator: !!spec.isOrchestrator,
  });

  if (spec.maxCostUsd != null || spec.maxElapsedMs != null) {
    deps.onLimitsSet?.(id, {
      maxCostUsd: spec.maxCostUsd,
      maxElapsedMs: spec.maxElapsedMs,
    });
  }

  const evtId = deps.events.append(id, deps.clock.now(), "spawn", {
    args: args.slice(2),
    pid: proc.pid,
  });
  deps.bus.publish("worker:spawn", { workerId: id, rowId: evtId });
  return { id, port };
}
