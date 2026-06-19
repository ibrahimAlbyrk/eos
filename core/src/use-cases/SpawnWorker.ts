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
import type { WorktreeManager } from "../ports/WorktreeManager.ts";
import type { ModelCapabilities } from "../ports/ModelCapabilities.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import { resolveEffort } from "../domain/effort.ts";
import { assertOwnedBy } from "../services/WorkerOwnership.ts";
import { ConflictError, NotFoundError } from "../errors/index.ts";

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
  /** Resume an existing claude session (`claude --resume <id>`) instead of
   * starting fresh. Set by ResumeWorker, never by a spawn route. */
  resumeSessionId?: string;
  /** Spawn INTO an existing worker's worktree (shared workspace) instead of
   * creating a fresh one. Resolved here: the target's worktree facts are
   * copied onto this spec and the worker boots in attach mode (no create,
   * no hydration, no teardown). Refused while the target is busy. */
  workspaceOf?: string;
  /** Resolved worktree directory. Internal: precomputed for fresh worktrees
   * via deps.resolveWorktreeDir or copied from the workspaceOf target —
   * never set by spawn routes. */
  worktreeDir?: string;
  /** Fork a fresh worktree from a snapshot of the source checkout's
   * uncommitted work instead of clean HEAD (settings: git.carryUncommitted).
   * Derived from user settings in the spawn route; ignored for attach mode. */
  carryUncommitted?: boolean;
  /** Hydrate gitignored .env files into a fresh worktree (node_modules is always
   * hydrated). Mirrors the claude-cli --hydrate-env flag; only consulted by the
   * in-process worktree bootstrap below. From config.worker.hydrateEnvFiles. */
  hydrateEnv?: boolean;
  /** Opt this worker into peer collaboration — registers the peer MCP tools
   * and injects the peer-collaboration prompt fragment. Set by the orchestrator
   * at spawn; immutable for the session. */
  collaborate?: boolean;
  /** Backend profile name (config `backends` key) this worker runs on — persisted
   * to the backend_profile column. Set by the spawn route's backend resolver;
   * absent ⇒ the default profile (null column). */
  backendProfile?: string;
  /** Resolved worker-type name. Persisted to worker_type; surfaced as the
   * immutable DPI `workerType` fact. "" / absent ⇒ untyped base worker. The
   * spawn handler resolves it — the use-case only carries + persists. */
  workerType?: string;
  /** The resolved type's instructions body, carried so the backend chokepoint
   * can build the synthetic DPI fragment. NOT persisted (re-resolved from disk
   * on resume); empty ⇒ no fragment. */
  workerTypeBody?: string;
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
  /** Builds the env map (the daemon-aware EOS_* triplet + bin paths). */
  buildEnv(input: { id: string; spec: SpawnWorkerSpec }): Record<string, string>;
  /** Derives the worktree dir for a fresh worktree spawn (realpath'd repo root
   * + the managed .eos/worktrees/<branch> layout) so the row is complete at
   * insert — no enrichment window. The worker creates the worktree at exactly
   * this path; its lifecycle event re-confirms it (idempotent). */
  resolveWorktreeDir?(repoRoot: string, branch: string): string;
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
  /** Write-capable worktree port. Used ONLY for in-process backends (claude-sdk):
   *  the daemon materializes the worktree before launch since there is no boot
   *  child to create it (claude-cli creates its own in worker.ts). Absent (unit
   *  tests / out-of-process) → no creation here. */
  worktrees?: WorktreeManager;
  /** Recent-folders log; updated with the resolved cwd after every spawn. */
  recents?: RecentsRepo;
  /** Capability lookup for effort normalization. Absent (unit tests,
   *  standalone) → requested effort passes through unchanged. */
  caps?: ModelCapabilities;
}

export async function spawnWorker(
  deps: SpawnWorkerDeps,
  spec: SpawnWorkerSpec,
): Promise<{ id: string; port: number }> {
  let resolved = spec.parentId ? { ...spec, persistent: true } : spec;

  // Attach mode: spawn INTO an existing worker's worktree. Copy the target's
  // worktree facts so the rest of the flow (args, insert, delete cleanup)
  // treats it like any worktree worker — except the worker boots with
  // --worktree-attach and never creates/hydrates/tears down. Refused while
  // the target is busy: two agents editing one tree mid-turn is a race.
  if (resolved.workspaceOf) {
    const target = deps.workers.findById(resolved.workspaceOf);
    if (!target) throw new NotFoundError("worker", resolved.workspaceOf);
    // An orchestrator may only attach into a worktree of a worker it spawned.
    if (resolved.parentId) assertOwnedBy(deps.workers, resolved.parentId, resolved.workspaceOf);
    if (!target.worktree_from || !target.branch || !target.worktree_dir) {
      throw new ConflictError("workspaceOf target has no worktree to attach to");
    }
    if (target.state === "SPAWNING" || target.state === "WORKING") {
      throw new ConflictError("workspaceOf target is busy — attach when it is idle");
    }
    resolved = {
      ...resolved,
      cwd: undefined,
      worktreeFrom: target.worktree_from,
      branch: target.branch,
      worktreeDir: target.worktree_dir,
    };
  }

  const id = resolved.fixedId ?? deps.ids.newWorkerId();
  const model = resolved.model ?? "opus";
  // xhigh matches claude's own default tier for current opus models. The
  // capability check clamps/drops a level the model can't take (haiku has no
  // effort at all) and fails open when the catalog doesn't know the model.
  const requestedEffort = resolved.effort ?? "xhigh";
  const effort = deps.caps
    ? resolveEffort(requestedEffort, await deps.caps.effortLevelsFor(model))
    : requestedEffort;
  if (effort !== requestedEffort) {
    deps.log.info("effort adjusted to model capability", {
      workerId: id, model, requested: requestedEffort, applied: effort ?? null,
    });
  }

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
      ? `eos-${label}${id}-${deps.clock.now().toString(36)}`
      : resolved.branch;
  // Complete the row at insert: a fresh worktree's dir is precomputed (the
  // worker creates it at exactly this path), an attach already carries the
  // target's dir. Kills the worktree_dir enrichment window the try/verify
  // routes used to 409 on.
  const worktreeDir =
    resolved.worktreeDir ??
    (resolved.worktreeFrom && branch && deps.resolveWorktreeDir
      ? deps.resolveWorktreeDir(resolved.worktreeFrom, branch)
      : undefined);
  // Carry the normalized effort on the spec: buildArgs derives the --effort
  // flag from spec.effort, so this is what actually reaches the claude CLI.
  const withBranch = { ...resolved, branch, worktreeDir, effort };

  // In-process backends (claude-sdk) have no boot child to create the worktree,
  // so the daemon materializes it HERE — before launch — so the session starts in
  // the isolated tree, not the source repo. claude-cli creates its own in
  // worker.ts (out-of-process). Attach mode reuses an existing tree (no create).
  const inProcess = deps.backend?.descriptor.processModel === "in-process";
  let inProcWorktreeDir: string | null = null;
  let inProcForkBaseSha: string | null = null;
  if (inProcess && deps.worktrees && resolved.worktreeFrom && branch && worktreeDir && !resolved.workspaceOf) {
    const created = await deps.worktrees.create({
      repoRoot: resolved.worktreeFrom,
      branch,
      worktreeDir,
      carryUncommitted: resolved.carryUncommitted,
      hydrateEnv: resolved.hydrateEnv,
    });
    if (!created.created) throw new Error(`worktree create failed: ${created.reason ?? "unknown"}`);
    inProcWorktreeDir = created.worktreeDir ?? worktreeDir;
    inProcForkBaseSha = created.forkBaseSha ?? null;
  }

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
        // Attach: the shared worktree already exists on disk. In-process fresh
        // worktree: just materialized above, so launch in it. claude-cli fresh
        // worktree: the dir is only precomputed (materializes during worker
        // boot), so the launch cwd stays the source repo.
        cwd: resolved.cwd ?? inProcWorktreeDir ?? (resolved.workspaceOf ? worktreeDir : undefined) ?? resolved.worktreeFrom ?? "",
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
    effort: effort ?? null,
    isOrchestrator: !!resolved.isOrchestrator,
    backendKind: deps.backend?.kind ?? "claude-cli",
    backendProfile: resolved.backendProfile ?? null,
    agentRole: resolved.role ?? null,
    workerType: resolved.workerType ?? null,
    withGateway: !!resolved.withGateway,
    collaborate: !!resolved.collaborate,
    worktreeDir: worktreeDir ?? null,
    workspaceOwnerId: resolved.workspaceOf ?? null,
    // Fresh worktree: the precomputed dir materializes during worker boot —
    // born not-ready, flipped by the claude_spawning enrichment. Plain-cwd,
    // attach, and in-process (created above, ready now) spawns point at a tree
    // that already exists.
    workspaceReady: !resolved.worktreeFrom || !!resolved.workspaceOf || inProcWorktreeDir !== null,
  });

  // In-process worktree: persist the fork base now (no claude_spawning enrichment
  // event for in-process backends). The realpath'd dir already matches the
  // precomputed worktreeDir written above, so only the fork base is new.
  if (inProcWorktreeDir && inProcForkBaseSha) {
    deps.workers.setForkBaseSha(id, inProcForkBaseSha);
  }

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
