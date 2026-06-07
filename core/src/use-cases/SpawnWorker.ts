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
import type { AgentBackend } from "../ports/AgentBackend.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

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
  role?: string;
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
  /** When injected, spawning goes through the AgentBackend (the claude-cli
   *  adapter owns port + argv + child). Absent → legacy supervisor path, which
   *  the unit tests exercise. This is the Phase 1 kill switch. */
  backend?: AgentBackend;
  /** Routes an in-process backend's canonical events into the daemon pipeline
   *  (events.append + reduceAgentSignal). Unused by out-of-process backends
   *  (claude-cli posts events over HTTP). Injected by the composition root. */
  onAgentEvent?(workerId: string, event: AgentEvent): void;
  /** Recent-folders log; updated with the resolved cwd after every spawn. */
  recents?: RecentsRepo;
}

export async function spawnWorker(
  deps: SpawnWorkerDeps,
  spec: SpawnWorkerSpec,
): Promise<{ id: string; port: number }> {
  const resolved = spec.parentId ? { ...spec, persistent: true } : spec;

  const id = resolved.fixedId ?? deps.ids.newWorkerId();
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

  // Daemon bookkeeping on child exit — shared by both spawn paths. The backend
  // path releases the port itself (it owns allocation); the legacy path releases
  // it here.
  const onExit = (code: number | null): void => {
    const now = deps.clock.now();
    deps.workers.markDone(id, now, code);
    deps.events.append(id, now, "exit", { code });
    deps.bus.publish("worker:exit", { workerId: id, code });
  };

  let port: number;
  let pid: number | null;
  let logArgs: string[] | null = null;

  if (deps.backend) {
    // Backend-driven spawn — the adapter owns port allocation + argv + the child
    // process. SpawnWorker only persists the result + does daemon bookkeeping.
    const session = await deps.backend.start(
      {
        workerId: id,
        cwd: resolved.cwd ?? resolved.worktreeFrom ?? "",
        model,
        effort,
        prompt: resolved.prompt,
        systemPromptFile: resolved.systemPromptFile ?? null,
        permissionMode: resolved.claudePermissionMode ?? null,
        persistent: !!resolved.persistent,
        parentId: resolved.parentId ?? null,
        isOrchestrator: !!resolved.isOrchestrator,
        backendOptions: { spec: withBranch },
      },
      { onExit, onEvent: (e) => deps.onAgentEvent?.(id, e) },
    );
    port = session.handle.kind === "http" ? session.handle.port : 0;
    pid = session.handle.kind === "http" ? session.handle.pid : null;
  } else {
    // Legacy supervisor path (kill switch: no backend injected; unit tests).
    port = await deps.ports.allocate();
    logArgs = deps.buildArgs({ id, port, spec: withBranch, model });
    const env = deps.buildEnv({ id, spec: withBranch });
    const proc = deps.supervisor.spawn(id, {
      args: logArgs,
      env,
      logFile: deps.logFileFor(id),
      onExit: (code) => {
        onExit(code);
        deps.ports.release(port);
      },
    });
    pid = proc.pid;
  }

  deps.workers.insert({
    id,
    prompt: resolved.prompt,
    cwd: resolved.cwd ?? null,
    worktreeFrom: resolved.worktreeFrom ?? null,
    branch: withBranch.branch ?? null,
    name: resolved.name ?? null,
    pid,
    port,
    startedAt: deps.clock.now(),
    parentId: resolved.parentId ?? null,
    model,
    effort,
    isOrchestrator: !!resolved.isOrchestrator,
    backendKind: deps.backend?.kind ?? "claude-cli",
    backendProfile: null,
    agentRole: resolved.role ?? null,
  });

  // A prompt-bearing spawn IS the start of a turn. The row is born busy
  // (SPAWNING), so TransitionState's non-busy→busy stamp never fires for the
  // boot turn — without this the UI elapsed timer stays blank until turn two.
  if (resolved.prompt && resolved.prompt.trim().length > 0) {
    deps.workers.setTurnStartedAt(id, deps.clock.now());
  }

  if (resolved.claudePermissionMode) {
    deps.workers.updatePermissionMode(id, resolved.claudePermissionMode);
  }

  const folder = resolved.cwd ?? resolved.worktreeFrom ?? null;
  if (folder) deps.recents?.push(folder);

  const evtId = deps.events.append(id, deps.clock.now(), "spawn", {
    ...(logArgs ? { args: logArgs.slice(2) } : {}),
    pid,
  });
  deps.bus.publish("worker:spawn", { workerId: id, rowId: evtId });
  return { id, port };
}
