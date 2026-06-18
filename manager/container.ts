// Composition root for the daemon. Wires every port to its concrete adapter
// in one place. Routes/middleware receive the container instead of reaching
// into module-scope globals.

import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, unlinkSync, existsSync, realpathSync } from "node:fs";

import { loadConfig, reloadConfig as reloadConfigFromDisk, type DaemonConfig, type ModelPrice } from "./shared/config.ts";
import { expandPath } from "./shared/path.ts";
import { buildWorkerArgs } from "./shared/worker-args.ts";
import { errMsg } from "../contracts/src/util.ts";

import { systemClock } from "../infra/src/time/SystemClock.ts";
import { randomIdGenerator } from "../infra/src/id/RandomIdGenerator.ts";
import { createLogger } from "../infra/src/observability/StructLogger.ts";
import { createInMemoryEventBus } from "../infra/src/eventbus/InMemoryEventBus.ts";
import { createPortAllocator } from "../infra/src/net/PortAllocator.ts";
import { createChildProcessSupervisor } from "../infra/src/supervision/ChildProcessSupervisor.ts";
import { createClaudeCliBackend } from "./backends/ClaudeCliBackend.ts";
import { createInProcessBackend } from "../infra/src/backends/InProcessBackend.ts";
import { createAnthropicModelClient } from "../infra/src/backends/AnthropicModelClient.ts";
import { createOpenAIModelClient } from "../infra/src/backends/OpenAIModelClient.ts";
import { processAgentSignal } from "../core/src/use-cases/ProcessAgentSignal.ts";
import { scrubSubscriptionEnv } from "../core/src/domain/env-allowlist.ts";
import type { AgentEvent } from "../contracts/src/canonical.ts";
import type { AgentBackend, AgentLaunchSpec } from "../core/src/ports/AgentBackend.ts";
import { createClaudeSdkBackend } from "./backends/sdk/ClaudeSdkBackend.ts";
import { createSubscriptionAuthResolver } from "../infra/src/auth/SubscriptionAuthResolver.ts";
import { makePolicyToolGate } from "./backends/PolicyToolGate.ts";
import { orchestratorDefs, workerDefs, peerDefs } from "./tools/registry.ts";
import { toRuntimeTool, prefixedToolName, mcpServerForRole, toolJsonSchema } from "./tools/projections.ts";
import { renderToolDescriptions } from "./tool-descriptions.ts";
import { daemonApi } from "./shared/http.ts";
import { spawnSync } from "node:child_process";
import type { WorkerRow } from "../contracts/src/worker.ts";
import { runMigrations, maybeVacuum } from "../infra/src/persistence/MigrationRunner.ts";
import { SqliteWorkerRepo } from "../infra/src/persistence/SqliteWorkerRepo.ts";
import { SqliteEventRepo } from "../infra/src/persistence/SqliteEventRepo.ts";
import { SqliteMessageQueueRepo } from "../infra/src/persistence/SqliteMessageQueueRepo.ts";
import { SqlitePendingRepo } from "../infra/src/persistence/SqlitePendingRepo.ts";
import { SqliteWorktreeRemovalQueue } from "../infra/src/persistence/SqliteWorktreeRemovalQueue.ts";
import { httpWorkerClient } from "../infra/src/ipc/HttpWorkerClient.ts";
import { loadPolicy } from "../infra/src/policy/YamlPolicyLoader.ts";
import { createDarwinFsHelpers, type FsHelpers } from "../infra/src/filesystem/DarwinFsHelpers.ts";
import { noopFsHelpers } from "../infra/src/filesystem/NoopFsHelpers.ts";
import { createNodeFileSystem } from "../infra/src/filesystem/NodeFileSystem.ts";
import { NodeFileWatcher } from "../infra/src/filesystem/NodeFileWatcher.ts";
import { FsWatchRegistry } from "./services/FsWatchRegistry.ts";
import { GitWatchReconciler } from "./services/GitWatchReconciler.ts";
import { childProcessGitInfo } from "../infra/src/git/ChildProcessGitInfo.ts";
import { ChokidarGitWatcher } from "../infra/src/git/ChokidarGitWatcher.ts";
import { childProcessWorktreeManager } from "../infra/src/git/ChildProcessWorktreeManager.ts";
import { createChildProcessBranchIntegration } from "../infra/src/git/ChildProcessBranchIntegration.ts";
import { childProcessBranchPush } from "../infra/src/git/ChildProcessBranchPush.ts";
import { childProcessConflictResolution } from "../infra/src/git/ChildProcessConflictResolution.ts";
import { childProcessBranchAdmin } from "../infra/src/git/ChildProcessBranchAdmin.ts";
import { childProcessWorkingTreeRestore } from "../infra/src/git/ChildProcessWorkingTreeRestore.ts";
import { childProcessRemoteSync } from "../infra/src/git/ChildProcessRemoteSync.ts";
import { gitUpdateSource } from "../infra/src/updates/GitUpdateSource.ts";
import { createDetachedBuildApplier } from "../infra/src/updates/DetachedBuildApplier.ts";
import { JsonRecentsRepo } from "../infra/src/persistence/JsonRecentsRepo.ts";
import { FileMcpServerCatalog } from "../infra/src/mcp/FileMcpServerCatalog.ts";
import { pruneOrphanWorktrees } from "../core/src/use-cases/PruneOrphanWorktrees.ts";
import { reapWorktreeRemovals } from "../core/src/use-cases/ReapWorktreeRemovals.ts";
import { reconcileWorkersOnBoot } from "../core/src/use-cases/ReconcileWorkersOnBoot.ts";
import { resolveMcpServers } from "../core/src/domain/mcp-resolution.ts";
import type { EosBuiltinMcpServer } from "../core/src/domain/tool-scope.ts";

import type { Policy } from "../core/src/domain/policy.ts";
import type { ModelCatalog } from "../core/src/ports/ModelCatalog.ts";
import { PolicyGatewayService } from "../core/src/services/PolicyGatewayService.ts";
import { SqlBackedModeResolver } from "../core/src/services/SqlBackedModeResolver.ts";
import { SqlBackedBackendResolver } from "../core/src/services/SqlBackedBackendResolver.ts";
import { PromptRegistry } from "../core/src/services/PromptRegistry.ts";
import { PromptService } from "../core/src/services/PromptService.ts";
import { assembleSystemPrompt } from "../core/src/use-cases/AssembleSystemPrompt.ts";
import { TOOL_NAME_VARS } from "./prompt-tool-names.ts";
import { SseBroadcaster } from "./sse/SseBroadcaster.ts";
import { TurnSettleService } from "./services/TurnSettleService.ts";
import { StartupBackupService } from "./services/StartupBackupService.ts";
import { FilePromptSource } from "../infra/src/prompt/FilePromptSource.ts";
import { FileProjectMemoryStore } from "../infra/src/persistence/FileProjectMemoryStore.ts";
import { UserTemplateService } from "./services/UserTemplateService.ts";
import { UserSettingsService } from "./services/UserSettingsService.ts";
import { ModelCatalogService } from "./services/ModelCatalogService.ts";
import { UpdateService } from "./services/UpdateService.ts";
import { PendingQuestionService } from "./services/PendingQuestionService.ts";
import { BackgroundActivityService } from "./services/BackgroundActivityService.ts";
import { PendingPeerRequestService } from "./services/PendingPeerRequestService.ts";
import { TerminalRunService } from "./services/TerminalRunService.ts";

import type { SpawnWorkerSpec, SpawnWorkerDeps } from "../core/src/use-cases/SpawnWorker.ts";
export { randomOrchestratorName } from "./shared/names.ts";

// The working dir the web keys git state on (mirrors ComposerDiffRow):
// worktree_dir for an isolated worker — but only once its workspace exists on
// disk, since the precomputed dir resolves UP to the source repo before that
// (same workspace_ready gate the git-read routes use; never fall back to the
// source repo for a not-yet-ready worktree, that would mis-key the event) —
// else cwd, else the source repo. Kept in lockstep with the web so a git:change
// event lands on the matching dir-keyed store entry.
function gitWorkingDirOf(w: WorkerRow): string | null {
  if (w.worktree_dir) return w.workspace_ready ? w.worktree_dir : null;
  return w.cwd ?? w.worktree_from ?? null;
}

export function buildContainer() {
  let config: DaemonConfig = loadConfig();
  const log = createLogger("daemon");

  // PID file ----------------------------------------------------------------
  try { writeFileSync(config.daemon.pidFile, String(process.pid)); } catch {}

  // User-data backup before opening the DB -----------------------------------
  try {
    new StartupBackupService(config.daemon.home, join(config.daemon.home, "backups")).run();
  } catch (e) {
    process.stderr.write(`[daemon] backup skipped: ${errMsg(e)}\n`);
  }

  // Open DB + run migrations -----------------------------------------------
  const db = new DatabaseSync(config.daemon.dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, log);
  maybeVacuum(db, log, "startup");
  setInterval(() => maybeVacuum(db, log, "scheduled"), 60 * 60 * 1000).unref();

  // Repos -------------------------------------------------------------------
  const workers = new SqliteWorkerRepo(db);
  const events = new SqliteEventRepo(db, config.events.maxPerWorker);
  const pending = new SqlitePendingRepo(db);
  const messageQueue = new SqliteMessageQueueRepo(db);
  const worktreeRemovals = new SqliteWorktreeRemovalQueue(db);
  // Dispatched ledger rows only feed the idempotency window + forensics —
  // a day is plenty; pending rows are never pruned.
  messageQueue.prune(systemClock.now() - 24 * 60 * 60 * 1000);
  // Bound the events table once at boot — the per-append throttle handles
  // steady state, this catches rows accumulated across prior daemon sessions.
  const prunedEvents = events.pruneAll(config.events.maxPerWorker);
  if (prunedEvents > 0) log.info("pruned events at startup", { rows: prunedEvents, keepPerWorker: config.events.maxPerWorker });

  // Stale-pending sweep — daemon may have died while requests were waiting.
  const swept = pending.sweepExpired(systemClock.now(), "daemon restart sweep");
  if (swept > 0) log.info("swept stale pending permissions", { count: swept });

  // Safe orphan-worktree prune — removes only row-gone eos-* worktrees left by
  // deleted workers (see PruneOrphanWorktrees for the conjunctive guards).
  // Fire-and-forget so a slow git scan never blocks daemon boot.
  void pruneOrphanWorktrees({ workers, worktrees: childProcessWorktreeManager, log })
    .catch((e) => log.warn("worktree prune failed", { error: e instanceof Error ? e.message : String(e) }));

  // Bus + SSE ---------------------------------------------------------------
  const bus = createInMemoryEventBus();
  const sse = new SseBroadcaster({ bus, keepaliveMs: config.daemon.sseKeepaliveMs });

  // Stale-worker reconcile — the supervisor map starts empty, so every non-DONE
  // row's process is gone. Resumable rows (session_id + cwd on disk) park as
  // SUSPENDED; the rest close as DONE.
  reconcileWorkersOnBoot({ workers, events, bus, clock: systemClock, log, pathExists: existsSync });

  // Process supervision + port allocator -----------------------------------
  const supervisor = createChildProcessSupervisor({
    binary: "node",
    logger: log.child({ scope: "supervisor" }),
  });
  const portAllocator = createPortAllocator({
    host: config.daemon.host,
    start: config.worker.portRangeStart,
    end: config.worker.portRangeEnd,
  });

  // Model catalog (pricing) -------------------------------------------------
  const models: ModelCatalog = {
    priceFor(model: string | null | undefined): ModelPrice {
      const m = String(model ?? "opus").toLowerCase();
      if (m in config.prices) return config.prices[m];
      if (m.includes("fable")) return config.prices.fable;
      if (m.includes("opus")) return config.prices.opus;
      if (m.includes("sonnet")) return config.prices.sonnet;
      if (m.includes("haiku")) return config.prices.haiku;
      return config.prices.opus;
    },
  };

  // Policy ------------------------------------------------------------------
  let policy: Policy = loadPolicy({
    candidates: [
      join(config.daemon.home, "policy.yaml"),
      join(config.paths.repoRoot, "manager", "policy.example.yaml"),
    ],
    defaultTtlMs: config.permissions.defaultTtlMs,
    log,
  });

  // Metrics counters --------------------------------------------------------
  const metrics = {
    startedAtMs: systemClock.now(),
    policyAllow: 0,
    policyDeny: 0,
    policyAsk: 0,
    policyRewrite: 0,
    requests: 0,
    bodyTooLarge: 0,
  };

  // Mode resolver — walks worker.parent_id chain to find the active mode.
  const modeResolver = new SqlBackedModeResolver(workers);
  // Backend selection: materialize named profiles + per-role defaults from the
  // frozen config, then a resolver that climbs parent_id for inheritance.
  const backendDefaults = {
    profile(name: string) {
      const p = config.backends[name];
      if (!p) return null;
      return { kind: p.kind, model: p.model, profileName: name, baseUrl: p.baseUrl, pricing: p.pricing, costMode: p.costMode, params: p.params };
    },
    roleDefaultName(isOrchestrator: boolean): string | null {
      return (isOrchestrator ? config.defaults.orchestrator.backend : config.defaults.worker.backend) ?? null;
    },
  };
  const backendResolver = new SqlBackedBackendResolver(workers, backendDefaults);

  // Policy gateway service --------------------------------------------------
  // Plan-mode workers must still write their plan artifact — fileEdits under
  // this dir classify as planFile and bypass the mode verdict.
  const claudeHome = expandPath(process.env.CLAUDE_CONFIG_DIR ?? "~/.claude")!;
  const plansDir = join(claudeHome, "plans");
  const policyGateway = new PolicyGatewayService({
    pending, events, bus, clock: systemClock, ids: randomIdGenerator,
    modeResolver,
    plansDir,
    getPolicy: () => policy,
    onDecision: (behavior) => {
      if (behavior === "allow") metrics.policyAllow++;
      else if (behavior === "deny") metrics.policyDeny++;
      else metrics.policyAsk++;
    },
  });

  // FS helpers (platform-specific) -----------------------------------------
  const fs: FsHelpers = process.platform === "darwin"
    ? createDarwinFsHelpers({
        helperScript: join(config.paths.repoRoot, "manager", "scripts", "macos-default-app.swift"),
        iconCacheDir: join(config.daemon.home, "icon-cache"),
      })
    : noopFsHelpers;

  // Files explorer: generic file ops + a chokidar directory watcher whose
  // change batches are published on the bus → SSE → web (the Files tab
  // re-lists only the affected dir). FsWatchRegistry ties watches to SSE
  // clients so a dropped tab releases them.
  const files = createNodeFileSystem({
    trashDir: join(config.daemon.home, ".eos-trash"),
    platform: process.platform,
  });
  const fileWatcher = new NodeFileWatcher({
    clock: systemClock,
    sink: (changes) => bus.publish("fs:change", { changes }),
  });
  const fsWatchRegistry = new FsWatchRegistry({ watcher: fileWatcher });

  // Git info + recents -----------------------------------------------------
  const git = childProcessGitInfo;
  const worktrees = childProcessWorktreeManager;
  const branchPush = childProcessBranchPush;
  const conflicts = childProcessConflictResolution;
  const branchAdmin = childProcessBranchAdmin;
  const workingTreeRestore = childProcessWorkingTreeRestore;
  const remoteSync = childProcessRemoteSync;
  const branchIntegration = createChildProcessBranchIntegration({
    triesDir: join(config.daemon.home, "tries"),
    now: () => systemClock.now(),
  });

  // Git state watcher — observes each live worker's .git internals + working
  // tree and publishes coalesced "git:change {dir, kinds}" events (→ SSE → the
  // web's dir-keyed git stores). This is what makes the composer git row update
  // instantly for EVERY mutation source — agent PTY, composer "!" terminal,
  // external shell, a sibling sharing the checkout — not just turns that happen
  // to emit a worker:change. The reconciler keeps the watch set in sync with the
  // live worker rows (debounced); events are keyed by the same working dir the
  // web keys on (gitWorkingDirOf).
  const gitWatcher = new ChokidarGitWatcher({
    clock: systemClock,
    sink: (ev) => bus.publish("git:change", ev),
    resolveDirs: (cwd) => git.gitDirs(cwd),
  });
  const gitWatchReconciler = new GitWatchReconciler({
    watcher: gitWatcher,
    desiredDirs: () => workers.listAll().map(gitWorkingDirOf).filter((d): d is string => !!d),
  });
  gitWatchReconciler.reconcile(); // boot: watch the workers reconciled above

  // Durable worktree reaper — drains the removal queue KillWorker writes to.
  // Runs once at boot (reclaims trees stranded by a crash/SIGKILL in a prior
  // session's grace window) and on a short interval (steady-state teardown).
  // The in-flight guard stops the boot tick and an interval tick from double-
  // processing; remove() is idempotent so even an overlap is harmless.
  const WORKTREE_REAP_INTERVAL_MS = 3000;
  let reaping = false;
  const reapWorktreesTick = (): void => {
    if (reaping) return;
    reaping = true;
    void reapWorktreeRemovals({ queue: worktreeRemovals, workers, worktrees, branchIntegration, clock: systemClock, log })
      .catch((e) => log.warn("worktree reap failed", { error: e instanceof Error ? e.message : String(e) }))
      .finally(() => { reaping = false; });
  };
  reapWorktreesTick();
  setInterval(reapWorktreesTick, WORKTREE_REAP_INTERVAL_MS).unref();

  const recents = new JsonRecentsRepo(join(config.daemon.home, "recents.json"));

  // UI-origin token. Required as the x-eos-ui-token header on every
  // checkout-mutating endpoint (/workers/:id/try*) so agents holding
  // EOS_DAEMON_URL cannot self-apply into the user's checkout. Written
  // to disk (0600) for the native app shell handshake — interim trust gate
  // until ADR-0001 trust tiers. PERSISTENT across daemon restarts: the app
  // injects it once at launch, and a per-boot rotation would 403 every open
  // app after an `eos restart`. Rotate by deleting the file.
  const uiTokenPath = join(config.daemon.home, "ui-token");
  let uiToken = "";
  try {
    const existing = readFileSync(uiTokenPath, "utf8").trim();
    if (/^[0-9a-f]{32,}$/.test(existing)) uiToken = existing;
  } catch {}
  if (!uiToken) {
    uiToken = randomBytes(24).toString("hex");
    try {
      writeFileSync(uiTokenPath, uiToken, { mode: 0o600 });
    } catch (e) {
      log.warn("ui-token write failed", { error: errMsg(e) });
    }
  }

  // SpawnWorker dep builders -----------------------------------------------
  const buildArgs: SpawnWorkerDeps["buildArgs"] = ({ id, port, spec, model }) => {
    const wire = writeMcpConfig({
      id,
      cwd: spec.cwd ?? spec.worktreeFrom,
      isOrchestrator: !!spec.isOrchestrator,
      withGateway: !!spec.withGateway,
      parentId: spec.parentId,
      collaborate: !!spec.collaborate,
    });
    const wiredSpec: SpawnWorkerSpec = wire.path
      ? { ...spec, mcpConfig: wire.path, mcpStrict: wire.strict, permissionPromptTool: wire.permissionPromptTool ?? spec.permissionPromptTool }
      : spec;
    return buildWorkerArgs({
      id,
      port,
      model,
      spec: wiredSpec,
      workerScript: config.paths.workerScript,
      daemonPort: config.daemon.port,
      worker: {
        heartbeatMs: config.worker.heartbeatMs,
        heartbeatQuietMs: config.worker.heartbeatQuietMs,
        shutdownGraceMs: config.worker.shutdownGraceMs,
        ptyWriteDelayMs: config.worker.ptyWriteDelayMs,
        hydrateEnvFiles: config.worker.hydrateEnvFiles,
      },
    });
  };

  // Mirrors the worker's own derivation (realpath'd repo root + the managed
  // .eos/worktrees/<branch> layout) so the precomputed dir and the dir the
  // worker actually creates are byte-identical.
  const resolveWorktreeDir: SpawnWorkerDeps["resolveWorktreeDir"] = (repoRoot, branch) =>
    join(realpathSync(resolve(repoRoot)), ".eos", "worktrees", branch);

  const buildEnv: SpawnWorkerDeps["buildEnv"] = () => ({
    // Scrub subscription-diverting provider keys so the claude-cli worker process
    // (and the PTY child it spawns) never inherits an API key (R3).
    ...scrubSubscriptionEnv(process.env),
    EOS_CLAUDE_BIN: config.paths.claudeBin,
    EOS_BUN_BIN: config.paths.bunBin,
    EOS_REPO_ROOT: config.paths.repoRoot,
    EOS_GATEWAY_SCRIPT: join(config.paths.repoRoot, "gateway", "server.ts"),
  });

  const logFileFor = (id: string): string => join(config.daemon.logDir, `${id}.log`);

  // Per-agent MCP config. Composes the type-specific built-in servers
  // (orchestrator / gateway / worker) with the user's inherited MCP servers
  // (filtered per config.mcp) into one mcp.json. `strict` tells the spawner
  // whether to isolate claude to this file — see core mcp-resolution. Written
  // at spawn (buildArgs) and removed by KillWorker via postKillCleanup.
  const mcpCatalog = new FileMcpServerCatalog();
  const mcpConfigPathFor = (id: string): string => join(config.daemon.home, `mcp-${id}.json`);
  const systemPromptPathFor = (id: string): string => join(config.daemon.home, `system-prompt-${id}.md`);

  const buildMcpBuiltins = (input: {
    id: string;
    isOrchestrator: boolean;
    withGateway: boolean;
    parentId: string | undefined;
    collaborate: boolean;
  }): { builtins: Record<string, unknown>; permissionPromptTool: string | undefined } => {
    const baseEnv = {
      ...process.env,
      EOS_DAEMON_URL: `http://127.0.0.1:${config.daemon.port}`,
      EOS_WORKER_ID: input.id,
    };
    const node = (script: string, extraEnv?: Record<string, string>) => ({
      command: "node",
      args: ["--no-warnings", "--experimental-strip-types", join(config.paths.repoRoot, "manager", script)],
      env: extraEnv ? { ...baseEnv, ...extraEnv } : baseEnv,
      alwaysLoad: true,
    });
    // Key set = EOS_BUILTIN_MCP_SERVERS — the subagent caller-scope deny
    // (core/domain/tool-scope.ts) matches on these server names.
    const builtins: Partial<Record<EosBuiltinMcpServer, unknown>> = {};
    if (input.isOrchestrator) builtins.orchestrator = node("orchestrator-mcp.ts");
    if (input.withGateway) {
      builtins.gateway = {
        command: config.paths.bunBin,
        args: ["run", join(config.paths.repoRoot, "gateway", "server.ts")],
        env: baseEnv,
      };
    }
    // EOS_COLLABORATE gates the peer MCP tools (list_peers / ask_peer /
    // respond_to_peer) inside the worker MCP server — read synchronously at its
    // boot, so no daemon round-trip / row-insert race.
    if (input.parentId) builtins.worker = node("worker-mcp.ts", { EOS_COLLABORATE: input.collaborate ? "1" : "" });
    return { builtins, permissionPromptTool: input.withGateway ? "mcp__gateway__decide" : undefined };
  };

  const writeMcpConfig = (input: {
    id: string;
    cwd: string | undefined;
    isOrchestrator: boolean;
    withGateway: boolean;
    parentId: string | undefined;
    collaborate: boolean;
  }): { path: string | null; strict: boolean; permissionPromptTool: string | undefined } => {
    const agentCfg = input.isOrchestrator ? config.mcp.orchestrator : config.mcp.worker;
    const { builtins, permissionPromptTool } = buildMcpBuiltins(input);
    const inherited = input.cwd ? mcpCatalog.listInherited(input.cwd) : {};
    const { servers, strict } = resolveMcpServers({ inherited, builtins, config: agentCfg });
    // Additive + nothing of ours to add → no file; claude inherits natively.
    if (!strict && Object.keys(servers).length === 0) {
      return { path: null, strict: false, permissionPromptTool };
    }
    const path = mcpConfigPathFor(input.id);
    writeFileSync(path, JSON.stringify({ mcpServers: servers }));
    return { path, strict, permissionPromptTool };
  };

  const cleanupMcpConfig = (id: string): void => {
    for (const p of [mcpConfigPathFor(id), systemPromptPathFor(id)]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {}
    }
  };

  const turnSettle = new TurnSettleService(systemClock);
  const pendingQuestions = new PendingQuestionService(randomIdGenerator, systemClock);
  const backgroundActivity = new BackgroundActivityService(systemClock);
  const pendingPeerRequests = new PendingPeerRequestService(randomIdGenerator, systemClock);
  const terminalRuns = new TerminalRunService({ bus, events, clock: systemClock, log });
  // Centralized prompt system (Layer 1) + DPI (Layer 2). Built-in library lives
  // in config.paths.promptsDir; ~/.eos/prompts overrides/extends it. Reads fresh
  // per reload so prompt edits apply on the next spawn without a daemon restart.
  const promptRegistry = new PromptRegistry(
    new FilePromptSource([config.paths.promptsDir, join(config.daemon.home, "prompts")]),
    log,
  );
  // Tool-name variables are static globals: constant per daemon, available to
  // every render (role fragments interpolate {{SPAWN_WORKER_TOOL}} etc.).
  const prompts = new PromptService(promptRegistry, TOOL_NAME_VARS);
  // DPI assembly (shared): derive the appended system-prompt TEXT from the
  // fragments that match the spawn facts. Both backend lanes need the same text —
  // claude-cli writes it to a file for --append-system-prompt-file, claude-sdk
  // passes it as systemPrompt.append — so it is built in exactly one place here.
  // null → no append (a top-level worker with no role fragment).
  const assembleAppendText = (spec: SpawnWorkerSpec, id: string): string | null => {
    const role = spec.isOrchestrator ? "orchestrator" : spec.role === "git" ? "git" : "worker";
    const { text } = assembleSystemPrompt(
      { registry: promptRegistry, prompts },
      {
        role,
        parentId: spec.parentId ?? null,
        name: spec.name ?? id,
        workerId: id,
        model: spec.model ?? "opus",
        effort: spec.effort ?? null,
        permissionMode: spec.claudePermissionMode ?? "acceptEdits",
        cwd: spec.cwd ?? spec.worktreeDir ?? spec.worktreeFrom ?? null,
        worktreeDir: spec.worktreeDir ?? null,
        branch: spec.branch ?? null,
        repoRoot: spec.worktreeFrom ?? null,
        isAttached: !!spec.workspaceOf,
        hasMcp: false,
        canCollaborate: !!spec.collaborate,
      },
    );
    return text.trim() ? text : null;
  };
  // claude-cli projection: write the assembled text per-worker, return the path
  // (cleanupMcpConfig removes the file on exit).
  const assembleSystemPromptFile = (spec: SpawnWorkerSpec, id: string): string | null => {
    const text = assembleAppendText(spec, id);
    if (!text) return null;
    const path = systemPromptPathFor(id);
    writeFileSync(path, text);
    return path;
  };
  const userTemplates = new UserTemplateService(join(config.daemon.home, "templates"));
  const projectMemory = new FileProjectMemoryStore();
  const userSettings = new UserSettingsService(join(config.daemon.home, "settings.json"));
  const modelCatalog = new ModelCatalogService(join(config.daemon.home, "models.json"), systemClock);

  // Auto-update — polls the configured git remote and offers a newer build to
  // the app (banner + native launch splash). Apply is a detached git pull +
  // eos build that outlives the daemon restart it triggers.
  const updates = new UpdateService({
    source: gitUpdateSource,
    applier: createDetachedBuildApplier({ logDir: config.daemon.logDir }),
    bus,
    clock: systemClock,
    repoRoot: config.paths.repoRoot,
    enabled: config.updates.enabled,
    log,
  });
  updates.start(config.updates.checkIntervalMs);


  // The claude-cli AgentBackend — wraps the existing supervisor + port allocator
  // + worker client + argv builders behind the backend-agnostic port. SpawnWorker
  // (and later DispatchMessage/KillWorker) drive execution through this.
  const claudeCliBackend = createClaudeCliBackend({
    supervisor,
    ports: portAllocator,
    client: httpWorkerClient,
    buildArgs,
    buildEnv,
    logFileFor,
    assembleSystemPromptFile,
  });

  // Shared in-process tooling, used by BOTH the claude-sdk lane and the Eos-hosted
  // ToolRuntime lane (anthropic-api / openai / deepseek / kimi): the daemon-loopback
  // ToolContext, the one policy engine, and the prompt-library descriptions.
  const sdkDaemonUrl = `http://127.0.0.1:${config.daemon.port}`;
  const inprocToolDescriptions = renderToolDescriptions(
    config.paths.promptsDir,
    [...orchestratorDefs, ...workerDefs, ...peerDefs].map((d) => d.name),
  );
  const sdkPolicy = {
    async decide(i: { workerId: string; toolName: string; input: Record<string, unknown> }) {
      const d = await policyGateway.decide(i);
      return { behavior: d.behavior === "allow" ? ("allow" as const) : ("deny" as const), message: d.message, updatedInput: d.updatedInput };
    },
  };
  const makeToolContext = (spec: AgentLaunchSpec) => ({
    selfId: spec.workerId,
    cwd: spec.cwd,
    isGitRepo: () => spawnSync("git", ["rev-parse", "--git-dir"], { cwd: spec.cwd, encoding: "utf8" }).status === 0,
    api: (method: string, path: string, body?: unknown) => daemonApi(sdkDaemonUrl, method, path, body),
  });
  // Orchestration tools projected onto the in-process ToolRuntime: prefixed
  // mcp__orchestrator__/worker__ names (so classifyTool always-allows them like the
  // PTY/SDK lanes), the executor map, and a provider-neutral JSON input schema.
  const buildLaneTooling = (spec: AgentLaunchSpec): { items: Array<{ name: string; description: string; schema: Record<string, unknown> }>; tools: Map<string, { name: string; execute(input: Record<string, unknown>): Promise<string> }> } => {
    const ctx = makeToolContext(spec);
    const collaborate = spec.backendOptions?.collaborate === true;
    const defs = spec.isOrchestrator ? orchestratorDefs : [...workerDefs, ...(collaborate ? peerDefs : [])];
    const server = mcpServerForRole(spec.isOrchestrator);
    const items = defs.map((d) => ({ name: prefixedToolName(server, d.name), description: inprocToolDescriptions[d.name] ?? d.name, schema: toolJsonSchema(d), execute: toRuntimeTool(d, ctx).execute }));
    const tools = new Map(items.map((i) => [i.name, { name: i.name, execute: i.execute }]));
    return { items, tools };
  };

  // anthropic-api backend — in-process, ToolRuntime-driven, gated by the shared
  // policy engine. Needs ANTHROPIC_API_KEY; opt-in via config (claude-cli default).
  const anthropicBackend = createInProcessBackend("anthropic-api", (spec) => {
    const { items, tools } = buildLaneTooling(spec);
    return {
      model: createAnthropicModelClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: spec.model, tools: items.map((i) => ({ name: i.name, description: i.description, input_schema: i.schema })) }),
      tools,
      gate: makePolicyToolGate(spec.workerId, sdkPolicy),
    };
  });
  // OpenAI-compatible backends (OpenAI, DeepSeek, Kimi/Moonshot, Codex-via-API, or
  // any compatible endpoint via OPENAI_BASE_URL). Same gated ToolRuntime path.
  const openaiEnv = (spec: AgentLaunchSpec) => {
    const { items, tools } = buildLaneTooling(spec);
    return {
      model: createOpenAIModelClient({ apiKey: process.env.OPENAI_API_KEY ?? "", model: spec.model, baseUrl: process.env.OPENAI_BASE_URL, tools: items.map((i) => ({ name: i.name, description: i.description, parameters: i.schema })) }),
      tools,
      gate: makePolicyToolGate(spec.workerId, sdkPolicy),
    };
  };
  const openaiBackend = createInProcessBackend("openai", openaiEnv);
  const codexBackend = createInProcessBackend("codex", openaiEnv);

  // claude-sdk (Lane A): subscription-billed, live thinking. Reuses the shared
  // policy engine + loopback ToolContext + prompt-library descriptions.
  const authResolver = createSubscriptionAuthResolver();
  const claudeSdkBackend = createClaudeSdkBackend({
    authResolver,
    policy: sdkPolicy,
    toolHost: { orchestratorDefs, workerDefs, peerDefs, renderDescription: (name) => inprocToolDescriptions[name] ?? name },
    daemonUrl: sdkDaemonUrl,
    makeToolContext,
    // Same DPI text the CLI lane writes to --append-system-prompt-file: the SDK
    // spec carries the SpawnWorkerSpec in backendOptions.spec (SpawnWorker.ts).
    assembleAppendPrompt: (spec) => assembleAppendText((spec.backendOptions?.spec ?? {}) as SpawnWorkerSpec, spec.workerId),
    log,
  });

  const backendMap = new Map<string, AgentBackend>([
    ["claude-cli", claudeCliBackend],
    ["anthropic-api", anthropicBackend],
    ["openai", openaiBackend],
    ["codex", codexBackend],
  ]);
  // claude-sdk is GA — registered unconditionally; selection is driven by config
  // (a claude-sdk profile + defaults). claude-cli stays the default until a profile points elsewhere.
  backendMap.set("claude-sdk", claudeSdkBackend);
  const backends = {
    get(kind: string) { const b = backendMap.get(kind); if (!b) throw new Error(`unknown backend: ${kind}`); return b; },
    has(kind: string) { return backendMap.has(kind); },
    descriptors() { return [...backendMap.values()].map((b) => b.descriptor); },
  };
  // Route an in-process backend's canonical events into the daemon pipeline
  // (log as agent_event + drive the state machine), mirroring the HTTP ingest
  // path that out-of-process (claude-cli) workers use.
  const onAgentEvent = (workerId: string, event: AgentEvent): void => {
    // Live deltas are ephemeral: relayed to the UI over SSE (the SseBroadcaster
    // rebroadcasts every bus topic), never persisted as an event row and never
    // driving worker state. The durable record stays the final `message` event.
    if (event.type === "delta") {
      bus.publish("agent:delta", { workerId, channel: event.channel, phase: event.phase, blockId: event.blockId, text: event.text });
      return;
    }
    processAgentSignal(
      { workers, events, bus, clock: systemClock, models, log, isSettling: (id) => turnSettle.isSettling(id), markSettling: (id) => turnSettle.mark(id) },
      workerId,
      event,
    );
  };

  return {
    get config() { return config; },
    log,
    db,
    bus,
    sse,
    clock: systemClock,
    ids: randomIdGenerator,
    workers,
    events,
    pending,
    messageQueue,
    worktreeRemovals,
    supervisor,
    portAllocator,
    httpWorkerClient,
    models,
    policyGateway,
    modeResolver,
    metrics,
    fs,
    files,
    fileWatcher,
    fsWatchRegistry,
    git,
    gitWatcher,
    gitWatchReconciler,
    worktrees,
    branchIntegration,
    branchPush,
    conflicts,
    branchAdmin,
    workingTreeRestore,
    remoteSync,
    uiToken,
    recents,
    buildArgs,
    buildEnv,
    resolveWorktreeDir,
    logFileFor,
    claudeCliBackend,
    backends,
    onAgentEvent,
    backendResolver,
    authResolver,
    turnSettle,
    pendingQuestions,
    backgroundActivity,
    pendingPeerRequests,
    terminalRuns,
    prompts,
    promptRegistry,
    userTemplates,
    projectMemory,
    claudeHome,
    userSettings,
    modelCatalog,
    updates,
    cleanupMcpConfig,
    reloadPolicy(): void {
      policy = loadPolicy({
        candidates: [
          join(config.daemon.home, "policy.yaml"),
          join(config.paths.repoRoot, "manager", "policy.example.yaml"),
        ],
        defaultTtlMs: config.permissions.defaultTtlMs,
        log,
      });
    },
    getPolicy(): Policy { return policy; },
    reloadConfig(): void { config = reloadConfigFromDisk(); },
  };
}

export type Container = ReturnType<typeof buildContainer>;
