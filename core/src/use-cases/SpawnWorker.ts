// SpawnWorker — composes argv, allocates a port, asks the supervisor to
// spawn a child process, persists the new row, and emits a `spawn` event.
// Knows nothing about node:child_process, node-pty, or sqlite directly.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { ProcessSupervisor } from "../ports/ProcessSupervisor.ts";
import type { PortAllocator } from "../ports/PortAllocator.ts";
import type { Clock } from "../ports/Clock.ts";
import type { IdGenerator } from "../ports/IdGenerator.ts";
import type { Logger } from "../ports/Logger.ts";
import type { RecentsRepo } from "../ports/RecentsRepo.ts";

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
  mcpStrict?: boolean;
  permissionPromptTool?: string;
  claudePermissionMode?: string;
  fixedId?: string;
  parentId?: string;
  model?: string;
  effort?: string;
  isOrchestrator?: boolean;
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
  /** Recent-folders log; updated with the resolved cwd after every spawn. */
  recents?: RecentsRepo;
}

export async function spawnWorker(
  deps: SpawnWorkerDeps,
  spec: SpawnWorkerSpec,
): Promise<{ id: string; port: number }> {
  const resolved = spec.parentId ? { ...spec, persistent: true } : spec;

  const id = resolved.fixedId ?? deps.ids.newWorkerId();
  const port = await deps.ports.allocate();
  const model = resolved.model ?? "opus";
  const effort = resolved.effort ?? "high";

  // Generate the worktree branch daemon-side so the DB always has a non-null
  // branch for a worktree worker (the worker used to auto-generate it and leave
  // the column NULL). This is what lets delete + the startup prune clean up
  // reliably. Clock port, not the system clock — core forbids it. The worker
  // then takes the explicit-branch path and never auto-generates. The unique
  // worker id guarantees no collision even if two same-named workers spawn in
  // the same millisecond; name + clock are only for readability/sorting.
  const label = resolved.name ? `${resolved.name}-` : "";
  const branch =
    resolved.worktreeFrom && !resolved.branch
      ? `cm-${label}${id}-${deps.clock.now().toString(36)}`
      : resolved.branch;
  const withBranch = { ...resolved, branch };

  const args = deps.buildArgs({ id, port, spec: withBranch, model });
  const env = deps.buildEnv({ id, spec: withBranch });
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
    prompt: resolved.prompt,
    cwd: resolved.cwd ?? null,
    worktreeFrom: resolved.worktreeFrom ?? null,
    branch: withBranch.branch ?? null,
    name: resolved.name ?? null,
    pid: proc.pid,
    port,
    startedAt: deps.clock.now(),
    parentId: resolved.parentId ?? null,
    model,
    effort,
    isOrchestrator: !!resolved.isOrchestrator,
  });

  if (resolved.claudePermissionMode) {
    deps.workers.updatePermissionMode(id, resolved.claudePermissionMode);
  }

  const folder = resolved.cwd ?? resolved.worktreeFrom ?? null;
  if (folder) deps.recents?.push(folder);

  const evtId = deps.events.append(id, deps.clock.now(), "spawn", {
    args: args.slice(2),
    pid: proc.pid,
  });
  deps.bus.publish("worker:spawn", { workerId: id, rowId: evtId });
  return { id, port };
}
