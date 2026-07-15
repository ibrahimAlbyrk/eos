// Composition root for the daemon. Wires every port to its concrete adapter
// in one place. Routes/middleware receive the container instead of reaching
// into module-scope globals.

import { DatabaseSync } from "node:sqlite";
import { join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, unlinkSync, existsSync, realpathSync } from "node:fs";

import { loadConfig, reloadConfig as reloadConfigFromDisk, priceForModel, type DaemonConfig, type ModelPriceSpec } from "./shared/config.ts";
import { expandPath } from "./shared/path.ts";
import { buildWorkerArgs } from "./shared/worker-args.ts";
import { errMsg } from "../contracts/src/util.ts";

import { systemClock } from "../infra/src/time/SystemClock.ts";
import { systemTimeZone } from "../infra/src/time/SystemTimeZone.ts";
import { randomIdGenerator } from "../infra/src/id/RandomIdGenerator.ts";
import { createLogger } from "../infra/src/observability/StructLogger.ts";
import { createInMemoryEventBus } from "../infra/src/eventbus/InMemoryEventBus.ts";
import { createPortAllocator } from "../infra/src/net/PortAllocator.ts";
import { createChildProcessSupervisor } from "../infra/src/supervision/ChildProcessSupervisor.ts";
import { createClaudeCliBackend } from "./backends/ClaudeCliBackend.ts";
import { createInProcessBackend } from "../infra/src/backends/InProcessBackend.ts";
import { JsonlConversationStore } from "../infra/src/conversation/JsonlConversationStore.ts";
import { DropOldestContextCompactor } from "../infra/src/conversation/DropOldestContextCompactor.ts";
import { createAnthropicModelClient } from "../infra/src/backends/AnthropicModelClient.ts";
import { createOpenAIModelClient } from "../infra/src/backends/OpenAIModelClient.ts";
import { LiteLlmModelPricingCatalog } from "../infra/src/backends/ModelPricingCatalog.ts";
import type { ProviderErrorInfo } from "../infra/src/backends/provider-error.ts";
import { processAgentSignal } from "../core/src/use-cases/ProcessAgentSignal.ts";
import { scrubSubscriptionEnv } from "../core/src/domain/env-allowlist.ts";
import type { AgentEvent } from "../contracts/src/canonical.ts";
import type { AgentBackend, AgentLaunchSpec } from "../core/src/ports/AgentBackend.ts";
import { backendCollaborate, backendRole } from "../core/src/ports/AgentBackend.ts";
import { createClaudeSdkBackend } from "./backends/sdk/ClaudeSdkBackend.ts";
import { createSubscriptionAuthResolver } from "../infra/src/auth/SubscriptionAuthResolver.ts";
import { makePolicyToolGate } from "./backends/PolicyToolGate.ts";
import { createInProcessEnvFactory, type SubagentRuntimeContext } from "./backends/in-process-env.ts";
import { runTurn, type RuntimeTool } from "../core/src/use-cases/ToolRuntime.ts";
import { mapSubagentEvent } from "./backends/subagent-events.ts";
import { createBuiltinToolRegistry } from "../infra/src/tools/builtins/registry.ts";
import { createNodeToolFileSystem } from "../infra/src/tools/NodeToolFileSystem.ts";
import { createNodeProcessRunner } from "../infra/src/tools/NodeProcessRunner.ts";
import { resolveWorkerDefinitionByName } from "../core/src/domain/worker-definition-resolution.ts";
import { buildBuiltinSurface, buildLaneSurface, taskToolItem, type LaneTooling } from "./backends/lane-tooling.ts";
import { SKILL_TOOL_NAME, skillToolItem, buildSkillTool, renderAvailableSkills } from "./backends/skill-tooling.ts";
import { createFileSkillCatalog } from "../infra/src/skills/FileSkillCatalog.ts";
import { createCommandTemplateExpander } from "./backends/command-expander.ts";
import { orchestratorDefs, workerDefs, peerDefs, workflowWorkerDefs } from "./tools/registry.ts";
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
import { SqliteLoopStateRepo } from "../infra/src/persistence/SqliteLoopStateRepo.ts";
import { SqliteContextMarkRepo } from "../infra/src/persistence/SqliteContextMarkRepo.ts";
import { SqliteWorkflowRunRepo } from "../infra/src/persistence/SqliteWorkflowRunRepo.ts";
import { SqliteWorkflowStepRepo } from "../infra/src/persistence/SqliteWorkflowStepRepo.ts";
import { SqliteRuntimeWorkflowDefinitionStore } from "../infra/src/persistence/SqliteRuntimeWorkflowDefinitionStore.ts";
import { FileWorkflowDefinitionSource, findProjectWorkflowDefinitionsDir } from "../infra/src/workflow/FileWorkflowDefinitionSource.ts";
import { NodeScriptRunner } from "../infra/src/workflow/NodeScriptRunner.ts";
import { BuiltinWorkflowDefinitionSource } from "./workflows/index.ts";
import { InMemoryStepExecutorRegistry } from "../core/src/workflow/registry.ts";
import { registerBuiltinExecutors } from "../core/src/workflow/register-builtins.ts";
import { WorkflowEngineImpl } from "../core/src/workflow/engine.ts";
import { WorkerSpawnAdapter, type StepSpawnRequest } from "./services/WorkerSpawnAdapter.ts";
import { EventBusProgressSink } from "./services/EventBusProgressSink.ts";
import { WorkflowService } from "./services/WorkflowService.ts";
import { renderWorkflowCompletion, makeWorkflowCompletionDelivery } from "./services/workflow-completion.ts";
import { dispatchMessage } from "../core/src/use-cases/DispatchMessage.ts";
import { dispatchDeps } from "./routes/dispatch-deps.ts";
import { spawnWorkerHandler } from "./commands/handlers/spawn-worker.ts";
import { killWorkerHandler } from "./commands/handlers/kill-worker.ts";
import {
  definitionOfRecord,
  type AnyWorkflowDefinition,
  type AnyWorkflowDefinitionRecord,
} from "../contracts/src/workflow-graph.ts";
import { DeterministicCommandStrategy } from "../infra/src/goalcheck/DeterministicCommandStrategy.ts";
import { GitEvidenceCollector } from "../infra/src/goalcheck/GitEvidenceCollector.ts";
import { LlmJudgeStrategy } from "../core/src/services/LlmJudgeStrategy.ts";
import { HybridStrategy } from "../core/src/services/HybridStrategy.ts";
import { makeStrategyFor } from "../core/src/services/goal-strategy-registry.ts";
import { AgentBackendJudgeClient } from "./services/AgentBackendJudgeClient.ts";
import { MicroTaskRunner } from "./services/MicroTaskRunner.ts";
import { buildMicroTasks } from "./services/micro-tasks/registry.ts";
import type { OneShotClient } from "../core/src/ports/OneShotClient.ts";
import { httpWorkerClient } from "../infra/src/ipc/HttpWorkerClient.ts";
import { loadPolicy } from "../infra/src/policy/YamlPolicyLoader.ts";
import { createDarwinFsHelpers, type FsHelpers } from "../infra/src/filesystem/DarwinFsHelpers.ts";
import { noopFsHelpers } from "../infra/src/filesystem/NoopFsHelpers.ts";
import { createNodeFileSystem } from "../infra/src/filesystem/NodeFileSystem.ts";
import { NodeFileWatcher } from "../infra/src/filesystem/NodeFileWatcher.ts";
import { TreeSitterSymbolIndex } from "../infra/src/symbols/TreeSitterSymbolIndex.ts";
import type { FsChangeEvent } from "../core/src/ports/FileWatcher.ts";
import { FsWatchRegistry } from "./services/FsWatchRegistry.ts";
import { GitWatchReconciler } from "./services/GitWatchReconciler.ts";
import { childProcessGitInfo } from "../infra/src/git/ChildProcessGitInfo.ts";
import { ChokidarGitWatcher } from "../infra/src/git/ChokidarGitWatcher.ts";
import { childProcessWorktreeManager } from "../infra/src/git/ChildProcessWorktreeManager.ts";
import { createChildProcessBranchIntegration } from "../infra/src/git/ChildProcessBranchIntegration.ts";
import { createChildProcessBranchMerge } from "../infra/src/git/ChildProcessBranchMerge.ts";
import { childProcessBranchPush } from "../infra/src/git/ChildProcessBranchPush.ts";
import { childProcessConflictResolution } from "../infra/src/git/ChildProcessConflictResolution.ts";
import { childProcessBranchAdmin } from "../infra/src/git/ChildProcessBranchAdmin.ts";
import { childProcessWorkingTreeRestore } from "../infra/src/git/ChildProcessWorkingTreeRestore.ts";
import { childProcessRemoteSync } from "../infra/src/git/ChildProcessRemoteSync.ts";
import { gitUpdateSource } from "../infra/src/updates/GitUpdateSource.ts";
import { createDetachedBuildApplier } from "../infra/src/updates/DetachedBuildApplier.ts";
import { JsonRecentsRepo } from "../infra/src/persistence/JsonRecentsRepo.ts";
import { FileMcpServerCatalog } from "../infra/src/mcp/FileMcpServerCatalog.ts";
import { createRuntimeMcpClient } from "../infra/src/mcp/RuntimeMcpClient.ts";
import { connectRuntimeMcpTools } from "./backends/runtime-mcp.ts";
import { FileMemoryProvider } from "../infra/src/memory/FileMemoryProvider.ts";
import { pruneOrphanWorktrees } from "../core/src/use-cases/PruneOrphanWorktrees.ts";
import { reapWorktreeRemovals } from "../core/src/use-cases/ReapWorktreeRemovals.ts";
import { purgeExpiredArchives } from "../core/src/use-cases/PurgeExpiredArchives.ts";
import { archivePurgeDeps } from "./shared/archive-purge.ts";
import { reconcileWorkersOnBoot } from "../core/src/use-cases/ReconcileWorkersOnBoot.ts";
import { resolveMcpServers } from "../core/src/domain/mcp-resolution.ts";
import { toSdkMcpServers } from "./backends/sdk/SdkMcpTranslator.ts";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { createSlashCommandRegistry } from "../core/src/domain/slash-command.ts";
import { clearCommand } from "../core/src/domain/commands/clear.ts";
import { resolveMemorySources } from "../core/src/domain/memory-sources.ts";
import { mergeAvailableWorkers } from "../core/src/domain/worker-definition-catalog.ts";
import { renderWorkflowDefinitionCatalog } from "../core/src/domain/workflow-definition-catalog.ts";
import { renderCapabilityCatalog } from "../core/src/domain/workflow-capability-catalog.ts";
import { buildWorkflowNodeCatalog } from "../core/src/domain/workflow-node-catalog.ts";
import { selectInjectableMemory } from "../core/src/services/select-injectable-memory.ts";
import { composeAppendedPrompt } from "../core/src/services/compose-appended-prompt.ts";
import type { EosBuiltinMcpServer } from "../core/src/domain/tool-scope.ts";
import { WorkerStateVO } from "../core/src/domain/value-objects.ts";

import type { Policy } from "../core/src/domain/policy.ts";
import type { ModelCatalog } from "../core/src/ports/ModelCatalog.ts";
import { PolicyGatewayService } from "../core/src/services/PolicyGatewayService.ts";
import { SqlBackedModeResolver } from "../core/src/services/SqlBackedModeResolver.ts";
import { SqlBackedToolScopeResolver } from "../core/src/services/SqlBackedToolScopeResolver.ts";
import { SqlBackedBackendResolver } from "../core/src/services/SqlBackedBackendResolver.ts";
import { PromptRegistry } from "../core/src/services/PromptRegistry.ts";
import { PromptService } from "../core/src/services/PromptService.ts";
import { assembleSystemPrompt } from "../core/src/use-cases/AssembleSystemPrompt.ts";
import { resolveTier, defaultTierName, CLAUDE_IDENTITY, type ProviderIdentity } from "../core/src/domain/model-tier.ts";
import { resolveProviderIdentity } from "./shared/provider-identity.ts";
import { renderModelTierTable, renderEffortSection, defaultEffortFor } from "./shared/tier-prompt-render.ts";
import { TOOL_NAME_VARS } from "./prompt-tool-names.ts";
import { SseBroadcaster } from "./sse/SseBroadcaster.ts";
import { TurnSettleService } from "./services/TurnSettleService.ts";
import { SuspendGuardService } from "./services/SuspendGuardService.ts";
import { TurnOutputTrackerService } from "./services/TurnOutputTracker.ts";
import { StartupBackupService } from "./services/StartupBackupService.ts";
import { FilePromptSource } from "../infra/src/prompt/FilePromptSource.ts";
import { FileWorkerDefinitionSource, findProjectWorkerDefinitionsDir } from "../infra/src/worker-definition/FileWorkerDefinitionSource.ts";
import type { WorkerDefinitionRecord } from "../contracts/src/worker-definition.ts";
import { parsePrompt } from "../core/src/services/prompt-parse.ts";
import { toFragment } from "../core/src/domain/prompt.ts";
import type { Fragment, RawPrompt } from "../core/src/domain/prompt.ts";
import { FileProjectMemoryStore } from "../infra/src/persistence/FileProjectMemoryStore.ts";
import { UserTemplateService } from "./services/UserTemplateService.ts";
import { UserSettingsService } from "./services/UserSettingsService.ts";
import { ModelCatalogService } from "./services/ModelCatalogService.ts";
import { UpdateService } from "./services/UpdateService.ts";
import { PendingQuestionService } from "./services/PendingQuestionService.ts";
import { SqliteRuntimeWorkerDefinitionStore } from "../infra/src/persistence/SqliteRuntimeWorkerDefinitionStore.ts";
import { BackgroundActivityService } from "./services/BackgroundActivityService.ts";
import { PendingPeerRequestService } from "./services/PendingPeerRequestService.ts";
import { TerminalRunService } from "./services/TerminalRunService.ts";
import { PtySessionService } from "./services/PtySessionService.ts";

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
  const loops = new SqliteLoopStateRepo(db);
  const contextMarks = new SqliteContextMarkRepo(db, systemClock);
  // Goal-check strategies (command/judge/hybrid) are constructed later, after the
  // appendless judge backend + git port exist (see strategyFor below).
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
  // Auto-pricing catalog: current cross-provider prices (LiteLLM map) fetched +
  // cached to ~/.eos so a provider added with only its API key still bills at real
  // prices. Loaded async (background refresh); the lookup is sync against the
  // in-memory index. config.prices stays a manual OVERRIDE (present → wins).
  const modelPricing = new LiteLlmModelPricingCatalog({
    cacheFile: join(config.daemon.home, "model-pricing-cache.json"),
    clock: systemClock,
  });
  modelPricing.start();
  // An unknown model (in neither config.prices nor the catalog) bills at a loud
  // known-zero (NOT the Opus default) + warns once per model, so an unpriced billed
  // turn is observable, never silently ~10×-overbilled at Opus rates (MJ2/Q0c).
  const warnedUnpricedModels = new Set<string>();
  const models: ModelCatalog = {
    priceFor(model: string | null | undefined): ModelPriceSpec {
      return priceForModel(config.prices, model, (m) => {
        if (warnedUnpricedModels.has(m)) return;
        warnedUnpricedModels.add(m);
        log.warn("no price for model — billing at zero; add it to config.prices", { model: m });
      }, (m) => modelPricing.lookup(m));
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
  // Tool-scope resolver — flat row lookup (scope is baked at spawn, immutable),
  // injected into the gate as the worker-definition capability-boundary rung.
  const toolScopeResolver = new SqlBackedToolScopeResolver(workers);
  // Backend selection: materialize named profiles + per-role defaults from the
  // frozen config, then a resolver that climbs parent_id for inheritance.
  const backendDefaults = {
    profile(name: string) {
      const p = config.backends[name];
      if (!p) return null;
      // Map p.auth + p.capabilities here (the §3.2 reconciliation: auth was dropped
      // at this hop) so the resolved backend carries the credential REFERENCE +
      // declared quirks down to the in-process env factory.
      return { kind: p.kind, model: p.model, profileName: name, baseUrl: p.baseUrl, auth: p.auth, pricing: p.pricing, costMode: p.costMode, params: p.params, capabilities: p.capabilities };
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
    toolScopeResolver,
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

  // Symbol index (tree-sitter tags) — daemon-side, in-memory per browsed root,
  // serving go-to-def / find-refs / symbol search by name matching. Freshness:
  // incrementally re-parse changed files under a resident root off the shallow
  // explorer watcher (fs:change); coarsely mark a root stale on a recursive
  // git-state change (git:change) for edits that watcher never emits (dim03
  // §2b). Multi-root memory is bounded by the adapter's LRU cap + release(root).
  const symbolIndex = new TreeSitterSymbolIndex({ notify: (msg, meta) => log.warn(msg, meta) });
  const isUnderRoot = (root: string, p: string): boolean =>
    p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  bus.subscribe("fs:change", (msg) => {
    const changes = (msg.payload as { changes: FsChangeEvent[] }).changes;
    for (const root of symbolIndex.residentRoots()) {
      const paths = changes.filter((ch) => isUnderRoot(root, ch.path)).map((ch) => ch.path);
      if (paths.length)
        void symbolIndex.invalidate(root, paths).catch((e) => log.warn("symbol invalidate failed", { root, error: errMsg(e) }));
    }
  });
  bus.subscribe("git:change", (msg) => {
    const dir = (msg.payload as { dir?: string }).dir;
    if (!dir) return;
    for (const root of symbolIndex.residentRoots()) {
      if (isUnderRoot(root, dir) || isUnderRoot(dir, root)) symbolIndex.markDirty(root);
    }
  });

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
  const branchMerge = createChildProcessBranchMerge({ now: () => systemClock.now() });

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
    notify: (msg, meta) => log.warn(msg, meta),
  });
  const gitWatchReconciler = new GitWatchReconciler({
    watcher: gitWatcher,
    // Only ACTIVE workers (SPAWNING/WORKING/IDLE) have a live process worth a
    // live-refresh watch. SUSPENDED/terminal rows must be excluded: at boot
    // (after a restart) running workers persist as SUSPENDED, and watching their
    // (possibly huge) trees would exhaust fds before any work starts. Resume
    // re-adds the watch via the bus reconcile when the row goes active again.
    desiredDirs: () =>
      workers
        .listAll()
        .filter((w) => WorkerStateVO.isActive(w.state))
        .map(gitWorkingDirOf)
        .filter((d): d is string => !!d),
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
      role: spec.role,
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

  // Per-agent MCP config. Composes the agent-specific built-in servers
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
    role: string | undefined;
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
    // respond_to_peer) inside the worker MCP server; EOS_ROLE selects the
    // workflow-worker tool surface — both read synchronously at its boot, so no
    // daemon round-trip / row-insert race.
    if (input.parentId) builtins.worker = node("worker-mcp.ts", { EOS_COLLABORATE: input.collaborate ? "1" : "", EOS_ROLE: input.role ?? "" });
    return { builtins, permissionPromptTool: input.withGateway ? "mcp__gateway__decide" : undefined };
  };

  const writeMcpConfig = (input: {
    id: string;
    cwd: string | undefined;
    isOrchestrator: boolean;
    withGateway: boolean;
    parentId: string | undefined;
    collaborate: boolean;
    role: string | undefined;
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
  // Intentional-suspend guard: suspendWorker marks a worker here before stopping
  // its session so the CLI/SDK onExit → markDone race can't clobber SUSPENDED.
  const suspendGuard = new SuspendGuardService(systemClock);
  // Per-worker "did this turn produce output yet?" — fed by the onAgentEvent
  // delta sink below, reset at dispatch (DispatchMessage), read by the interrupt
  // handler's recall decision. Never sourced from the durable log (deltas aren't logged).
  const turnOutput = new TurnOutputTrackerService();
  const pendingQuestions = new PendingQuestionService(randomIdGenerator, systemClock);
  const backgroundActivity = new BackgroundActivityService(systemClock);
  const pendingPeerRequests = new PendingPeerRequestService(randomIdGenerator, systemClock, config.collaborate.awaitTimeoutMs);
  const terminalRuns = new TerminalRunService({ bus, events, clock: systemClock, log });
  // Interactive multi-tab PTY sessions (the `pty` feature). Default cwd = the
  // daemon project root; a create request may override it.
  const ptySessions = new PtySessionService({ bus, defaultCwd: config.paths.repoRoot });
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
  // Worker-definition sources: built-in (manager/workers) < user (~/.eos/workers)
  // < project (nearest .eos/workers walking up from the spawn cwd). Read fresh
  // per spawn so definition edits + new files apply with no daemon restart.
  const builtinWorkerDefinitionsDir = config.paths.workerDefinitionsDir;
  const userWorkerDefinitionsDir = join(config.daemon.home, "workers");
  const listWorkerDefinitionRecords = (cwd: string | null): WorkerDefinitionRecord[] => {
    const dirs = [
      { dir: builtinWorkerDefinitionsDir, source: "builtin" as const },
      { dir: userWorkerDefinitionsDir, source: "user" as const },
    ];
    const proj = cwd ? findProjectWorkerDefinitionsDir(cwd) : null;
    if (proj) dirs.push({ dir: proj, source: "project" as const });
    return new FileWorkerDefinitionSource(dirs).list();
  };
  // Runtime (orchestrator-created) worker definitions — per-owner, persisted in
  // state.db so they survive a daemon restart (the resumed owner keeps its id).
  const runtimeWorkerDefinitions = new SqliteRuntimeWorkerDefinitionStore(db);
  // Cascade: when a worker row is permanently removed (KillWorker publishes
  // worker:removed), drop any runtime definitions it owned so dead-orchestrator
  // rows don't accumulate. A no-op for non-owner workers (0 rows deleted).
  bus.subscribe("worker:removed", (msg) =>
    runtimeWorkerDefinitions.deleteForOwner((msg.payload as { workerId: string }).workerId),
  );
  // Orchestrator catalog: one line per disk definition — name, its SET defaults
  // (model/effort/permission, unset axes omitted so no empty brackets), then the
  // routing signal. Lets the orchestrator route on capability, not just description.
  const renderWorkerDefinitionCatalog = (records: WorkerDefinitionRecord[]): string =>
    records
      .map((r) => {
        const axes = [r.model, r.effort, r.permissionMode].filter(Boolean).join("/");
        const head = axes ? `- ${r.name} [${axes}]` : `- ${r.name}`;
        const hint = (r.whenToUse || r.description || "").replace(/\s+/g, " ").trim();
        return hint ? `${head}: ${hint}` : head;
      })
      .join("\n");
  // Configured memory sources (CLAUDE.md, plus any AGENTS.md-style files declared
  // under config.memory.sources). Read for backends that don't load a source
  // natively (assumeNativeFor): the claude-cli binary auto-loads CLAUDE.md, the
  // claude-sdk lane (settingSources:[]) loads nothing.
  const memoryProvider = new FileMemoryProvider(resolveMemorySources(config.memory.sources));
  // Agent Skills (§5c) — discovery + body load for the in-process lane. Skill
  // trigger metadata (name+description) is folded into the in-process DPI prompt
  // below (the §5h slot); the Skill RuntimeTool loads a body on manual invocation.
  // The claude lanes discover + auto-trigger skills natively, so this is in-process
  // only — gated by the lane parameter in assembleAppendText, never a `when` gate.
  const skillCatalog = createFileSkillCatalog();
  // DPI assembly (shared): derive the appended system-prompt TEXT from the
  // fragments that match the spawn facts. Both backend lanes need the same text —
  // claude-cli writes it to a file for --append-system-prompt-file, claude-sdk
  // passes it as systemPrompt.append — so it is built in exactly one place here.
  // null → no append (a top-level worker with no role fragment).
  const assembleAppendText = (spec: SpawnWorkerSpec, id: string, lane: string): string | null => {
    const role = spec.isOrchestrator ? "orchestrator"
      : spec.role === "git" ? "git"
      : spec.role === "workflow-worker" ? "workflow-worker"
      : "worker";
    const lookupCwd = spec.cwd ?? spec.worktreeDir ?? spec.worktreeFrom ?? null;
    // The resolved definition body becomes one synthetic role/20 fragment (built-in,
    // user, project, and runtime bodies reach the prompt byte-identically). A
    // whitespace-only body (e.g. the defaults-only `git` definition) yields none.
    const extra: Fragment[] = [];
    // N1 — the in-process lane has no binary preset behind it, so it gets the
    // generic base harness (claude_code-equivalent framing) injected HERE, keyed on
    // the lane PARAMETER (never a `when` gate — the immutable-when rule forbids
    // gating on backend). The fragment is content-only (no dpi block), so it is never
    // auto-selected for the claude lanes; we attach a synthetic core/early dpi so it
    // sorts first. Same injection mechanism as the worker-definition body below.
    if (lane === "in-process" && promptRegistry.has("lane/in-process")) {
      extra.push({ prompt: promptRegistry.get("lane/in-process"), dpi: { layer: "core", priority: -100 } });
    }
    // Skill trigger metadata (§5c / MJ6): for the in-process lane ONLY (the lane has
    // no binary to discover skills), fold each visible skill's name+description into
    // the prompt via the SAME `extra` mechanism as the worker-def body — keyed on the
    // lane PARAMETER, never a `when` gate. The claude lanes discover skills natively,
    // so they never reach here. Built as a synthetic tool-layer fragment.
    if (lane === "in-process") {
      const skillsBlock = renderAvailableSkills(skillCatalog.listSkills(lookupCwd));
      if (skillsBlock) {
        const raw: RawPrompt = { id: "skills/available", frontmatter: { dpi: { layer: "tool", priority: 50 }, variables: [] }, body: skillsBlock };
        try {
          const frag = toFragment(parsePrompt(raw));
          if (frag) extra.push(frag);
        } catch {
          // A malformed skills block must not break the spawn — skip the fragment.
        }
      }
    }
    if (spec.workerDefinition && spec.workerDefinitionBody && spec.workerDefinitionBody.trim()) {
      const raw: RawPrompt = {
        id: `definition/${spec.workerDefinition}`,
        frontmatter: { dpi: { layer: "role", priority: 20 }, variables: [] },
        body: spec.workerDefinitionBody,
      };
      try {
        const frag = toFragment(parsePrompt(raw));
        if (frag) extra.push(frag);
      } catch {
        // A malformed definition body must not break the spawn — skip the fragment.
      }
    }
    const workerDefinitionCatalog =
      role === "orchestrator"
        ? renderWorkerDefinitionCatalog(
            mergeAvailableWorkers(listWorkerDefinitionRecords(lookupCwd), runtimeWorkerDefinitions.listFor(id)),
          )
        : "";
    // Dynamic per-spawn LIST of available workflow definitions (orchestrator only),
    // mirroring the worker catalog. The registry-derived capability VOCABULARY is a
    // daemon constant (workflowCapabilityCatalog) injected for every role — fragment
    // gating, not the var, decides who sees it.
    const workflowDefinitionCatalog =
      role === "orchestrator"
        ? renderWorkflowDefinitionCatalog(listWorkflowDefinitionRecords(lookupCwd, id))
        : "";
    // The session's OWN backend identity — spec.providerIdentity when the spawn route
    // attached it, else recompute from the backend profile (resume/legacy paths). No
    // worker-default lookup: an unpinned worker inherits its parent's backend, so the
    // session's own resolved backend IS what its children run under.
    const identity = identityForSpec(spec);
    const { text } = assembleSystemPrompt(
      { registry: promptRegistry, prompts },
      {
        role,
        parentId: spec.parentId ?? null,
        name: spec.name ?? id,
        workerId: id,
        model: resolveTier(spec.model ?? defaultTierName(identity), identity),
        effort: spec.effort ?? null,
        permissionMode: spec.claudePermissionMode ?? "acceptEdits",
        cwd: spec.cwd ?? spec.worktreeDir ?? spec.worktreeFrom ?? null,
        worktreeDir: spec.worktreeDir ?? null,
        branch: spec.branch ?? null,
        repoRoot: spec.worktreeFrom ?? null,
        isAttached: !!spec.workspaceOf,
        hasMcp: false,
        canCollaborate: !!spec.collaborate,
        workerDefinition: spec.workerDefinition ?? "",
        workerDefinitionCatalog,
        workflowDefinitionCatalog,
        workflowCapabilityCatalog,
        personaName: identity.persona,
        modelTierTable: renderModelTierTable(identity),
        defaultTier: defaultTierName(identity),
        effortSection: renderEffortSection(identity),
        defaultEffort: defaultEffortFor(identity),
        effortSupported: identity.effortSupported,
      },
      extra,
    );
    return text.trim() ? text : null;
  };
  // A spec's own-backend identity: the route-attached identity, else recomputed from
  // the persisted backend profile (resume/legacy). No profile ⇒ a claude lane.
  const identityForSpec = (spec: SpawnWorkerSpec): ProviderIdentity => {
    if (spec.providerIdentity) return spec.providerIdentity;
    const profile = spec.backendProfile ? config.backends[spec.backendProfile] : undefined;
    const descriptor = profile && backends.has(profile.kind) ? backends.get(profile.kind).descriptor : null;
    return descriptor ? resolveProviderIdentity(descriptor, profile, log) : CLAUDE_IDENTITY;
  };
  // DPI text + the memory this backend kind does NOT load itself
  // (selectInjectableMemory drops sources whose assumeNativeFor includes the kind).
  // Shared by both lanes: claude-cli writes it to the append file, claude-sdk
  // passes it inline. Memory disabled / no cwd → plain DPI text, verbatim.
  const assembleAppendFor = (spec: SpawnWorkerSpec, id: string, backendKind: string): string | null => {
    const dpi = assembleAppendText(spec, id, backendKind);
    if (!config.memory.enabled) return dpi;
    const cwd = spec.cwd ?? spec.worktreeDir ?? spec.worktreeFrom ?? null;
    if (!cwd) return dpi;
    const snapshot = memoryProvider.load({ cwd, repoRoot: spec.worktreeFrom ?? null });
    return composeAppendedPrompt(dpi, selectInjectableMemory(snapshot, backendKind));
  };
  // claude-cli projection: write the assembled text per-worker, return the path
  // (cleanupMcpConfig removes the file on exit). "claude-cli" filters out its native
  // CLAUDE.md (the binary loads it); only non-native sources are injected.
  const assembleSystemPromptFile = (spec: SpawnWorkerSpec, id: string): string | null => {
    const text = assembleAppendFor(spec, id, "claude-cli");
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
  const sdkPolicy = {
    async decide(i: { workerId: string; toolName: string; input: Record<string, unknown>; agentId?: string | null }) {
      const d = await policyGateway.decide(i);
      return { behavior: d.behavior === "allow" ? ("allow" as const) : ("deny" as const), message: d.message, updatedInput: d.updatedInput };
    },
  };
  // Credential resolver — defined here (before the in-process backends) because the
  // async in-process env factory resolves provider creds BY REFERENCE at start().
  // Shared with the claude-sdk lane below.
  const authResolver = createSubscriptionAuthResolver();
  const makeToolContext = (spec: AgentLaunchSpec) => ({
    selfId: spec.workerId,
    cwd: spec.cwd,
    isGitRepo: () => spawnSync("git", ["rev-parse", "--git-dir"], { cwd: spec.cwd, encoding: "utf8" }).status === 0,
    api: (method: string, path: string, body?: unknown) => daemonApi(sdkDaemonUrl, method, path, body),
  });
  // Bare-named built-in tool surface (Read/Write/Edit/Bash/Glob/Grep/…) for the
  // in-process lane: one registry, cwd-scoped per spawn. Gated for free by the
  // policy stack because every tool uses its BARE canonical name + canonical input
  // fields. The fs/process adapters are stateless, so one registry is shared.
  const nodeToolFs = createNodeToolFileSystem();
  const nodeProcessRunner = createNodeProcessRunner();
  const builtinToolRegistry = createBuiltinToolRegistry({
    fs: nodeToolFs,
    proc: nodeProcessRunner,
  });
  // Prompt-template (.md slash-command) expander (§5c) for lanes that don't expand
  // natively. DispatchMessage gates this on capabilities.expandsSlashTemplates (false
  // for in-process; the claude lanes self-expand), so it never double-expands.
  const expandSlashTemplate = createCommandTemplateExpander({ fs: nodeToolFs, proc: nodeProcessRunner });
  // Tool descriptions (control defs + bare-named built-ins + Task) are authored as
  // prompt fragments (prompts/tool/<name>) and rendered fresh per spawn — not cached at
  // construct-time — so editing a tool .md takes effect on the next spawn with no daemon
  // restart, parity with the claude-cli MCP subprocess that re-reads the prompt library
  // each spawn. Control descriptions key by def name; the built-in + Task descriptions
  // are overlaid onto the lane ITEMS (the in-process analog of withToolDescriptions).
  const builtinDescriptionNames = [...builtinToolRegistry.list().map((t) => t.name), "Task", SKILL_TOOL_NAME];
  const renderInprocToolDescriptions = (): Record<string, string> =>
    renderToolDescriptions(config.paths.promptsDir, [
      ...[...orchestratorDefs, ...workerDefs, ...peerDefs, ...workflowWorkerDefs].map((d) => d.name),
      ...builtinDescriptionNames,
    ]);
  // The built-in surface for a spec (NO control tools) — used directly for the Task
  // child surface (built-ins only) and merged into buildLaneTooling for parents. The
  // built-in descriptions are overlaid from the prompt library.
  // Merge the Skill item+tool (§5c) into a surface so BOTH the parent lane surface
  // and the Task child surface offer it — skills are non-control, so the child's
  // agentId gate leaves them callable. cwd-scoped: loadBody resolves project skills.
  const mergeSkillTooling = (surface: LaneTooling, cwd: string | null, descriptions: Record<string, string>): void => {
    surface.items.push(skillToolItem(descriptions));
    surface.tools.set(SKILL_TOOL_NAME, buildSkillTool(skillCatalog, cwd));
  };
  const buildBuiltinTooling = (spec: AgentLaunchSpec): LaneTooling => {
    const descriptions = renderInprocToolDescriptions();
    const surface = buildBuiltinSurface(builtinToolRegistry, { cwd: spec.cwd, isOrchestrator: spec.isOrchestrator, scope: spec.backendOptions?.spec?.toolScope, owner: spec.workerId }, descriptions);
    mergeSkillTooling(surface, spec.cwd, descriptions);
    return surface;
  };

  // Orchestration tools projected onto the in-process ToolRuntime: prefixed
  // mcp__orchestrator__/worker__ names (so classifyTool always-allows them like the
  // PTY/SDK lanes), MERGED with the bare-named built-ins ⊕ (non-orchestrators) the
  // Task subagent item (executor bound in the env factory).
  const buildLaneTooling = (spec: AgentLaunchSpec): { items: Array<{ name: string; description: string; schema: Record<string, unknown> }>; tools: Map<string, { name: string; execute(input: Record<string, unknown>): Promise<string> }> } => {
    const ctx = makeToolContext(spec);
    const collaborate = backendCollaborate(spec.backendOptions);
    const defs = backendRole(spec.backendOptions) === "workflow-worker" ? workflowWorkerDefs
      : spec.isOrchestrator ? orchestratorDefs
      : [...workerDefs, ...(collaborate ? peerDefs : [])];
    const server = mcpServerForRole(spec.isOrchestrator);
    const descriptions = renderInprocToolDescriptions();
    const control: LaneTooling = { items: [], tools: new Map() };
    for (const d of defs) {
      const name = prefixedToolName(server, d.name);
      control.items.push({ name, description: descriptions[d.name] ?? d.name, schema: toolJsonSchema(d) });
      control.tools.set(name, { name, execute: toRuntimeTool(d, ctx).execute });
    }
    const surface = buildLaneSurface(builtinToolRegistry, control, { cwd: spec.cwd, isOrchestrator: spec.isOrchestrator, scope: spec.backendOptions?.spec?.toolScope, owner: spec.workerId }, descriptions);
    mergeSkillTooling(surface, spec.cwd, descriptions);
    return surface;
  };

  // The complete in-process DPI system prompt (B1): the SAME assembler all lanes
  // share, with lane "in-process" so selectInjectableMemory injects ALL memory and
  // the lane base harness is folded in. backendOptions.spec is the SpawnWorkerSpec.
  const assembleInProcessSystem = (spec: AgentLaunchSpec): string | null =>
    assembleAppendFor((spec.backendOptions?.spec ?? {}) as SpawnWorkerSpec, spec.workerId, "in-process");
  const inProcessGate = (workerId: string) => makePolicyToolGate(workerId, sdkPolicy);

  // Task (subagent) closure (§5e / MJ5). Built per session in the env factory AFTER
  // creds resolve; each invocation runs a nested ToolRuntime for the child with:
  //   • a built-ins-only surface (NO control tools — the primary isolation defense),
  //   • the child's own DPI system prompt (subagent_type → a worker definition body),
  //   • a gate carrying agentId=childId so rung-0.5 hard-denies any control tool the
  //     child attempts (defense-in-depth atop the surface omission),
  //   • the parent's resolved creds + dialect (never process.env), and
  //   • the SHARED parent abort signal (an interrupt propagates).
  // Depth is capped; over-cap returns an error result instead of recursing.
  const MAX_TASK_DEPTH = 2;
  const buildChildSpec = (parentSpec: AgentLaunchSpec, subagentType: string, childId: string): AgentLaunchSpec => {
    const parentSWS = (parentSpec.backendOptions?.spec ?? {}) as SpawnWorkerSpec;
    const body = resolveWorkerDefinitionByName(subagentType, listWorkerDefinitionRecords(parentSpec.cwd ?? null))?.body ?? "";
    const childSWS: SpawnWorkerSpec = {
      ...parentSWS,
      cwd: parentSpec.cwd,
      isOrchestrator: false,
      role: undefined,
      parentId: parentSpec.workerId,
      collaborate: false,
      workerDefinition: subagentType,
      workerDefinitionBody: body,
    };
    return {
      workerId: childId,
      cwd: parentSpec.cwd,
      model: parentSpec.model,
      effort: parentSpec.effort,
      prompt: "",
      persistent: false,
      parentId: parentSpec.workerId,
      isOrchestrator: false,
      backendOptions: { ...parentSpec.backendOptions, spec: childSWS },
    };
  };
  const makeSubagentTool = (rt: SubagentRuntimeContext): RuntimeTool => ({
    name: "Task",
    spawnsSubagent: true,
    async execute(input, ctx) {
      if (rt.depth >= MAX_TASK_DEPTH) {
        return `Task depth limit reached (max ${MAX_TASK_DEPTH}) — complete this work directly rather than spawning a deeper subagent.`;
      }
      const subagentType = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general-purpose";
      const prompt = typeof input.prompt === "string" ? input.prompt
        : typeof input.description === "string" ? input.description : "";
      const childId = randomIdGenerator.newWorkerId();
      const childSpec = buildChildSpec(rt.parentSpec, subagentType, childId);
      const system = assembleInProcessSystem(childSpec) ?? undefined;
      const { items, tools } = buildBuiltinTooling(childSpec);
      // Share the session's external-MCP tools with the child (§5c): same already-
      // connected clients (session-scoped, closed once at stop). External MCP tools
      // are not control tools, so the child's agentId gate leaves them callable.
      if (rt.mcpItems) items.push(...rt.mcpItems);
      if (rt.mcpTools) for (const [name, tool] of rt.mcpTools) tools.set(name, tool);
      // Grandchildren up to the cap (recursion through this same closure).
      if (rt.depth + 1 < MAX_TASK_DEPTH) {
        items.push(taskToolItem(renderInprocToolDescriptions()));
        tools.set("Task", makeSubagentTool({ ...rt, parentSpec: childSpec, depth: rt.depth + 1 }));
      }
      const model = rt.buildModelClient({ apiKey: rt.apiKey, baseUrl: rt.baseUrl, model: childSpec.model, system, items, capabilities: rt.capabilities, params: rt.params, effort: rt.effort, workerId: childId });
      const gate = makePolicyToolGate(childId, sdkPolicy, { agentId: childId });
      // Parent this child's inner tools to THIS Task call's tool_call id (what the
      // UI's agentRun is keyed by) — the callId threaded into execute. A depth-2+
      // child parents to its immediate parent Task's callId, itself an inner activity
      // with no agentRun, so the UI's timestamp-proximity fallback flattens it onto
      // the outermost Task's agentRun (same shape as claude-sdk's nested subagents).
      const taskCallId = ctx?.callId ?? childId;
      let finalText = "";
      const childEmit = (e: AgentEvent): void => {
        // The child's terminal text is the Task result — capture it, but keep it OUT
        // of the parent stream (mirrors SdkEventMapper: subagent text is internal).
        if (e.type === "message" && e.role === "assistant") {
          const text = e.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
          if (text) finalText = text;
        }
        // Child inner tools → parented activity under the agentRun; usage forwarded;
        // text/reasoning/turn/delta/context/session dropped (loop-internal / summarized).
        for (const out of mapSubagentEvent(taskCallId, e)) rt.emit(out);
      };
      try {
        await runTurn(
          { model, tools, gate, emit: childEmit, signal: rt.signal, contextWindow: rt.capabilities?.contextWindow, compactor: rt.compactor, capabilities: rt.capabilities, skillToolName: SKILL_TOOL_NAME },
          [{ role: "user", content: prompt }],
        );
      } finally {
        // The child's surface tagged its background shells with childId; the child loop
        // is done and can no longer read them, so reap them now (MJ2) rather than
        // leaking them for the parent session's lifetime.
        nodeProcessRunner.reap(childId);
      }
      return finalText || "(subagent produced no text output)";
    },
  });

  // Durability deps (MJ7) shared by every in-process kind: a persisted turn lets
  // an orphaned worker (incl. a persistent orchestrator) survive a daemon restart
  // (boot reconcile → SUSPENDED → resume rehydrates). Stored dialect-neutral under
  // ~/.eos/conversations (non-regenerable user data). ids = the same generator the
  // rest of the daemon uses (no Math.random in the backend).
  const inProcessDurability = { store: new JsonlConversationStore(join(config.daemon.home, "conversations")), ids: randomIdGenerator };
  // M4 — shared context compactor: drops oldest matched tool-turns near the model's
  // contextWindow so a small-context model compacts instead of a raw 400 (D8).
  const inProcessCompactor = new DropOldestContextCompactor();
  // m5 — a typed provider-error structured log on the round-trip-error / refusal
  // paths (the missing-price path is logged at priceFor). Built per client with its
  // backend label; model + workerId give the diagnosable correlation.
  const providerErrorSink = (backend: string, model: string, workerId?: string) =>
    (e: ProviderErrorInfo): void => log.warn("provider error", { backend, model, workerId, transport: e.transport, status: e.status });

  // M5 — external-MCP RuntimeTools for the in-process lane (§5c): the third
  // emit/consume adapter, symmetric to resolveSdkMcpServers below. REUSE the shared
  // core precedence (resolveMcpServers, nativeDiscovery:false → materialize the
  // filtered inherited set, since this lane cannot self-discover) + the
  // FileMcpServerCatalog UNCHANGED. builtins is EMPTY: Eos control tools are
  // separate prefixed RuntimeTools here, not MCP servers. Each resolved server is
  // connected by an embedded RuntimeMcpClient, listed, and wrapped as
  // mcp__<server>__<tool> (gated mcp-always-allow); a dead server is dropped
  // (fail-soft), and the toolset's close() tears the connections down at stop().
  const resolveRuntimeMcpTools = (spec: AgentLaunchSpec) => {
    const cfg = spec.isOrchestrator ? config.mcp.orchestrator : config.mcp.worker;
    const inherited = spec.cwd ? mcpCatalog.listInherited(spec.cwd) : {};
    const { servers } = resolveMcpServers({ inherited, builtins: {}, config: cfg, nativeDiscovery: false });
    return connectRuntimeMcpTools(servers, (name, serverConfig) => createRuntimeMcpClient(name, serverConfig), log);
  };

  // anthropic-api backend — in-process, ToolRuntime-driven, gated by the shared
  // policy engine. Credentials/baseUrl/capabilities are resolved per-worker from the
  // profile (no process.env); the model gets the full DPI system prompt.
  const anthropicBackend = createInProcessBackend("anthropic-api", createInProcessEnvFactory({
    assembleSystem: assembleInProcessSystem,
    buildLaneTooling,
    authResolver,
    makeGate: inProcessGate,
    makeSubagentTool,
    compactor: inProcessCompactor,
    resolveMcpTools: resolveRuntimeMcpTools,
    skillToolName: SKILL_TOOL_NAME,
    reapShells: (workerId) => nodeProcessRunner.reap(workerId),
    buildModelClient: ({ apiKey, baseUrl, model, system, items, capabilities, params, effort, workerId }) =>
      createAnthropicModelClient({ apiKey, baseUrl, model, system, capabilities, params, effort, onProviderError: providerErrorSink("anthropic-api", model, workerId), tools: items.map((i) => ({ name: i.name, description: i.description, input_schema: i.schema })) }),
  }), inProcessDurability);
  // OpenAI-compatible backends (OpenAI, DeepSeek, Kimi/Moonshot, Codex-via-API, or
  // any compatible endpoint via a per-profile baseUrl). Same gated ToolRuntime path.
  // A fresh factory per kind (no shared closure) keeps each registration's dialect
  // bound at construction — never a runtime kind branch.
  const makeOpenAiEnvFactory = () => createInProcessEnvFactory({
    assembleSystem: assembleInProcessSystem,
    buildLaneTooling,
    authResolver,
    makeGate: inProcessGate,
    makeSubagentTool,
    compactor: inProcessCompactor,
    resolveMcpTools: resolveRuntimeMcpTools,
    skillToolName: SKILL_TOOL_NAME,
    reapShells: (workerId) => nodeProcessRunner.reap(workerId),
    buildModelClient: ({ apiKey, baseUrl, model, system, items, capabilities, params, effort, workerId }) =>
      createOpenAIModelClient({ apiKey, baseUrl, model, system, capabilities, params, effort, onProviderError: providerErrorSink("openai", model, workerId), tools: items.map((i) => ({ name: i.name, description: i.description, parameters: i.schema })) }),
  });
  const openaiBackend = createInProcessBackend("openai", makeOpenAiEnvFactory(), inProcessDurability);
  const codexBackend = createInProcessBackend("codex", makeOpenAiEnvFactory(), inProcessDurability);

  // claude-sdk (Lane A): subscription-billed, live thinking. Reuses the shared
  // policy engine + loopback ToolContext + prompt-library descriptions.
  // SDK-lane emit adapter, symmetric to writeMcpConfig's JSON path: enumerate the
  // worker's inherited servers (the SDK can't self-discover with settingSources:[],
  // so nativeDiscovery:false materializes them), reuse the shared core precedence
  // (builtins win), then translate to the SDK union. Wired ONTO claudeSdkBackend
  // only; judgeBackend omits it and stays clean.
  const resolveSdkMcpServers = (spec: AgentLaunchSpec, builtins: Record<string, McpServerConfig>) => {
    const cfg = spec.isOrchestrator ? config.mcp.orchestrator : config.mcp.worker;
    const inherited = spec.cwd ? mcpCatalog.listInherited(spec.cwd) : {};
    const { servers } = resolveMcpServers({ inherited, builtins, config: cfg, nativeDiscovery: false });
    return toSdkMcpServers(servers);
  };
  const claudeSdkBackend = createClaudeSdkBackend({
    authResolver,
    policy: sdkPolicy,
    toolHost: { orchestratorDefs, workerDefs, peerDefs, workflowWorkerDefs, renderDescriptions: renderInprocToolDescriptions },
    daemonUrl: sdkDaemonUrl,
    makeToolContext,
    resolveSdkMcpServers,
    // Same DPI text the CLI lane writes to --append-system-prompt-file, plus the
    // injected memory: the SDK spec carries the SpawnWorkerSpec in backendOptions.spec
    // (SpawnWorker.ts). "claude-sdk" loads nothing natively → every enabled source
    // is folded into the inline systemPrompt append.
    assembleAppendPrompt: (spec) => assembleAppendFor((spec.backendOptions?.spec ?? {}) as SpawnWorkerSpec, spec.workerId, "claude-sdk"),
    log,
  });

  // Appendless judge backend — a claude-sdk session with NO assembleAppendPrompt
  // and EMPTY tool defs, so the LLM judge sees ONLY the rubric (no Eos DPI
  // protocol, no injected memory, no Eos tools). A DISTINCT instance from
  // claudeSdkBackend above, which bakes the worker protocol in.
  const judgeBackend = createClaudeSdkBackend({
    authResolver,
    policy: sdkPolicy,
    toolHost: { orchestratorDefs: [], workerDefs: [], peerDefs: [], workflowWorkerDefs: [], renderDescriptions: () => ({}) },
    daemonUrl: sdkDaemonUrl,
    makeToolContext,
    // assembleAppendPrompt OMITTED → boots with only the stock claude_code preset.
    log,
  });

  // Goal-check strategy registry. "command" = deterministic verify commands;
  // "judge" = the skeptical LLM judge over collected artifacts (diff + machine
  // signals) on the appendless backend; "hybrid" = deterministic first, judge
  // second. An unknown name throws (the gate logs it; the loop stays inert).
  const deterministicStrategy = new DeterministicCommandStrategy(config.paths.repoRoot);
  const judgeClient = new AgentBackendJudgeClient({
    backend: judgeBackend,
    auth: authResolver,
    newId: () => randomIdGenerator.newPendingId(),
    cwd: config.paths.repoRoot,
    defaultModel: config.loop.judge.model,
    log,
  });
  const evidenceCollector = new GitEvidenceCollector({ git, repoRoot: config.paths.repoRoot });
  const llmJudgeStrategy = new LlmJudgeStrategy({ judge: judgeClient, evidence: evidenceCollector, renderer: prompts, temperature: config.loop.judge.temperature, log });
  const hybridStrategy = new HybridStrategy({ deterministic: deterministicStrategy, judge: llmJudgeStrategy });
  const strategyFor = makeStrategyFor({
    command: deterministicStrategy,
    judge: llmJudgeStrategy,
    hybrid: hybridStrategy,
  });

  // Micro-task subsystem — small predetermined-prompt Haiku tasks off the bus.
  // The OneShotClient is a thin reuse of the judge one-shot engine (judgeClient),
  // so there is ZERO new LLM infra; the per-call model comes from task config.
  // config is read live (it's a `let` reassigned by reloadConfig), so toggling
  // microTasks.* in ~/.eos/config.json takes effect without a code change.
  const oneShot: OneShotClient = { complete: (p, o) => judgeClient.judge(p, o) };
  const microTasks = new MicroTaskRunner({
    bus,
    oneShot,
    prompts,
    clock: systemClock,
    log,
    tasks: buildMicroTasks({
      workers,
      events,
      bus,
      cfg: () => config.microTasks.tasks["auto-name"],
    }),
    subsystemEnabled: () => config.microTasks.enabled,
    configFor: (id) => config.microTasks.tasks[id],
    pauseMaxMs: () => config.microTasks.pauseMaxMs,
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
  // Slash-command allowlist — intercepted at the dispatch chokepoint. Adding a
  // command is one entry here (the registry is open/closed); the side effects it
  // may touch are wired in dispatch-deps from the services below.
  const slashCommands = createSlashCommandRegistry([clearCommand]);
  // Route an in-process backend's canonical events into the daemon pipeline
  // (log as agent_event + drive the state machine), mirroring the HTTP ingest
  // path that out-of-process (claude-cli) workers use.
  const onAgentEvent = (workerId: string, event: AgentEvent): void => {
    // Live deltas are ephemeral: relayed to the UI over SSE (the SseBroadcaster
    // rebroadcasts every bus topic), never persisted as an event row and never
    // driving worker state. The durable record stays the final `message` event.
    if (event.type === "delta") {
      // First visible token of the turn (reasoning OR text) = the agent
      // responded → an interrupt past this point is a normal interrupt, not a
      // recall. Earliest, fullest proof of output (deltas never reach the log).
      turnOutput.markSeen(workerId);
      bus.publish("agent:delta", { workerId, channel: event.channel, phase: event.phase, blockId: event.blockId, text: event.text });
      return;
    }
    // Fallback for backends with deltas off: a durable assistant message also
    // means the turn produced output (deltas always precede it on the SDK lane).
    if (event.type === "message" && event.role === "assistant") {
      turnOutput.markSeen(workerId);
    }
    processAgentSignal(
      { workers, events, bus, clock: systemClock, models, log, isSettling: (id) => turnSettle.isSettling(id), markSettling: (id) => turnSettle.mark(id) },
      workerId,
      event,
    );
  };

  // ===== Workflow-orchestration engine (§3) ================================
  // Daemon-resident deterministic interpreter + its persistence, the spawn-join
  // adapter, and the driver service. A late-bound self-reference (a holder mutated
  // after the container is built) lets the step/expert spawn + teardown reuse the
  // existing command handlers (which need the fully-built container); they only
  // fire when a run is started, long after boot, so the late binding is safe.
  const self: { c?: Container } = {};
  const workflowRuns = new SqliteWorkflowRunRepo(db);
  const workflowSteps = new SqliteWorkflowStepRepo(db);
  const runtimeWorkflowDefinitions = new SqliteRuntimeWorkflowDefinitionStore(db);
  // Drop an owner's runtime workflow definitions when its row is permanently
  // removed (mirrors the worker-definition cascade).
  bus.subscribe("worker:removed", (msg) =>
    runtimeWorkflowDefinitions.deleteForOwner((msg.payload as { workerId: string }).workerId),
  );
  const userWorkflowDefinitionsDir = join(config.daemon.home, "workflows");
  const builtinWorkflowDefinitions = new BuiltinWorkflowDefinitionSource();
  // The single source list both the resolver (find-one) and the orchestrator
  // catalog (list-all) read: builtin code-DSL modules < on-disk user/project files
  // < the owner's runtime store. Factored to keep the dir logic in one place (DRY).
  const listWorkflowDefinitionRecords = (cwd: string | null, ownerId: string): AnyWorkflowDefinitionRecord[] => {
    const dirs = [{ dir: userWorkflowDefinitionsDir, source: "user" as const }];
    const proj = cwd ? findProjectWorkflowDefinitionsDir(cwd) : null;
    if (proj) dirs.push({ dir: proj, source: "project" as const });
    return [
      ...builtinWorkflowDefinitions.list(),
      ...new FileWorkflowDefinitionSource(dirs).list(),
      ...runtimeWorkflowDefinitions.listFor(ownerId),
    ];
  };
  // Definition-overlay resolver (clone of the worker-def resolver): nearest-wins
  // (last match by name), so the builtins are listed FIRST (lowest precedence); an
  // unknown name returns null → the run use-case throws a hard error. Returns a v1
  // tree OR a v2 graph (file-authored graphs flow through here unchanged).
  const resolveWorkflowDefinition = (name: string, ownerId: string): AnyWorkflowDefinition | null => {
    const ownerRow = workers.findById(ownerId);
    const cwd = ownerRow?.worktree_dir ?? ownerRow?.cwd ?? null;
    let found: AnyWorkflowDefinition | null = null;
    for (const r of listWorkflowDefinitionRecords(cwd, ownerId)) {
      if (r.name === name) found = definitionOfRecord(r);
    }
    return found;
  };
  // The HTTP list-definitions surface (GET /workflows/definitions): the same merged
  // overlay the resolver reads, with the owner's cwd derived exactly as above — so
  // the editor's Library + from/subGraph selectors see runtime-stored defs too.
  const listWorkflowDefinitions = (ownerId: string): AnyWorkflowDefinitionRecord[] => {
    const ownerRow = workers.findById(ownerId);
    const cwd = ownerRow?.worktree_dir ?? ownerRow?.cwd ?? null;
    return listWorkflowDefinitionRecords(cwd, ownerId);
  };
  // Step/expert spawn goes through the command handler (so from-definition /
  // tool-scope / mode / backend resolution come for free — §3.5). The request now
  // carries the run owner's cwd as worktreeFrom (threaded from the launching
  // orchestrator, mirroring spawn_worker), so a run's workers start in the owner's
  // path. repoRoot is the safety net ONLY when neither is present (an unknown-cwd
  // edge: an owner-less/operator run, or a pre-cwd anchor on resume).
  const runStepSpawn = (req: StepSpawnRequest): Promise<{ id: string }> => {
    const withCwd = req.cwd || req.worktreeFrom ? req : { ...req, worktreeFrom: config.paths.repoRoot };
    return spawnWorkerHandler.run({}, withCwd, { c: self.c!, requestId: "workflow" }).then((r) => ({ id: r.body.id }));
  };
  // Teardown reuses KillWorker (recursive subtree reap) with no actorId — the
  // daemon-resident engine is trusted, the ownership gate is for agent kills.
  const runStepKill = (id: string): void => {
    void killWorkerHandler.run({ id, actorId: undefined }, {}, { c: self.c!, requestId: "workflow" })
      .catch((e) => log.warn("workflow worker teardown failed", { id, error: e instanceof Error ? e.message : String(e) }));
  };
  const workflowProgress = new EventBusProgressSink(bus);
  const workflowSpawn = new WorkerSpawnAdapter({
    bus, steps: workflowSteps, workers, clock: systemClock,
    runSpawn: runStepSpawn, killWorker: runStepKill,
    stepTimeoutMs: config.workflow.defaultStepTimeoutMs,
  });
  const workflowRegistry = new InMemoryStepExecutorRegistry();
  // Trusted `script` node runner (§ITEM 1): resolves a script NAME only against
  // the operator-controlled allowlist (~/.eos/scripts), never an arbitrary path.
  const scriptRunner = new NodeScriptRunner({
    scriptDirs: [join(config.daemon.home, "scripts")],
    defaultCwd: config.paths.repoRoot,
    defaultTimeoutMs: config.workflow.defaultScriptTimeoutMs,
  });
  const { transforms: workflowTransforms } = registerBuiltinExecutors(workflowRegistry, undefined, scriptRunner);
  // Registry-derived capability VOCABULARY for the orchestrator prompt: node-type +
  // transform-fn names straight from the live registries, so the prompt can never
  // drift (a new executor/fn — e.g. the `script` node — shows up automatically). A
  // daemon constant: the registries are fixed once registered.
  const workflowCapabilityCatalog = renderCapabilityCatalog(workflowRegistry.types(), workflowTransforms.names());
  // Structured palette catalog for the node-editor UI (GET /workflows/catalog):
  // the graph node-kinds with their default typed port shapes, plus the LIVE
  // transform-fn names from the registry (so a newly-registered fn shows up).
  const workflowNodeCatalog = {
    nodeKinds: buildWorkflowNodeCatalog(),
    transformFns: workflowTransforms.names(),
  };
  const workflowEngine = new WorkflowEngineImpl({
    registry: workflowRegistry,
    runs: workflowRuns,
    steps: workflowSteps,
    spawn: workflowSpawn,
    progress: workflowProgress,
    clock: systemClock,
    ids: randomIdGenerator,
    log,
    maxConcurrentSteps: config.workflow.maxConcurrentSteps,
    resolveDefinition: resolveWorkflowDefinition,
  });
  const workflowService = new WorkflowService({
    engine: workflowEngine,
    runs: workflowRuns,
    spawn: workflowSpawn,
    progress: workflowProgress,
    definitions: runtimeWorkflowDefinitions,
    isBuiltinDefinition: (name) => builtinWorkflowDefinitions.list().some((r) => r.name === name),
    resolveDefinition: resolveWorkflowDefinition,
    resolveMode: (ownerId) => modeResolver.resolveFor(ownerId),
    // On resume, recover the run cwd from the persisted anchor row (worktree_from,
    // set by mintRunAnchor at run start) so the re-armed run spawns its steps in
    // the orchestrator's path; null ⇒ repoRoot fallback at runStepSpawn.
    resolveRunCwd: (anchorId) => {
      const anchor = workers.findById(anchorId);
      return anchor?.worktree_from ?? anchor?.cwd ?? undefined;
    },
    // On completion deliver the FULL result to the run owner — but ONLY when the
    // owner is a live agent with an inbox (A6.4). An operator-owned run (CLI / an
    // owner-less HTTP POST) has no agent row, so its completion is skipped here and
    // read back via GET /workflows/:id + SSE instead. self.c is late-bound (this
    // closure only fires when a run completes, long after boot). The stable
    // clientMsgId makes a boot re-arm's re-completion idempotent.
    deliverCompletion: makeWorkflowCompletionDelivery({
      isAgentOwner: (ownerId) => workers.findById(ownerId) != null,
      deliverToInbox: (ownerId, result) => {
        const body = renderWorkflowCompletion(result);
        void dispatchMessage(dispatchDeps(self.c!), {
          workerId: ownerId,
          text: body,
          displayText: body,
          // A run completion is the engine speaking, not a worker — system
          // provenance. runId + terminal status ride as tag attributes.
          envelope: { kind: "worker_report", provenance: "system", fromWorker: result.runId, workerName: "workflow", status: result.status },
          queueWhenBusy: true,
          clientMsgId: `wf-complete:${result.runId}`,
          origin: "workflow-completion",
        }).catch((e) => log.warn("workflow completion dispatch failed", { error: errMsg(e) }));
      },
      log,
    }),
    ids: randomIdGenerator,
    log,
  });

  const container = {
    get config() { return config; },
    log,
    db,
    bus,
    sse,
    clock: systemClock,
    timeZone: systemTimeZone,
    ids: randomIdGenerator,
    workers,
    events,
    pending,
    messageQueue,
    worktreeRemovals,
    loops,
    contextMarks,
    strategyFor,
    judgeBackend,
    microTasks,
    supervisor,
    turnOutput,
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
    symbolIndex,
    git,
    gitWatcher,
    gitWatchReconciler,
    worktrees,
    branchIntegration,
    branchMerge,
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
    slashCommands,
    expandSlashTemplate,
    onAgentEvent,
    backendResolver,
    authResolver,
    turnSettle,
    suspendGuard,
    pendingQuestions,
    backgroundActivity,
    pendingPeerRequests,
    terminalRuns,
    ptySessions,
    prompts,
    promptRegistry,
    listWorkerDefinitionRecords,
    runtimeWorkerDefinitions,
    workflowRuns,
    workflowSteps,
    workflowDefinitions: runtimeWorkflowDefinitions,
    listWorkflowDefinitions,
    workflowSpawn,
    workflowService,
    workflowNodeCatalog,
    userTemplates,
    projectMemory,
    claudeHome,
    userSettings,
    modelCatalog,
    modelPricing,
    updates,
    cleanupMcpConfig,
    // Kill/purge cascade leak cleanup: drop a session's ~/.eos conversation
    // transcript. Closure keeps core Node-free (DIP — wired at composition root).
    deleteConversation(sessionId: string): void { inProcessDurability.store.delete(sessionId); },
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
  // Late-bind the self-reference the workflow spawn/teardown closures capture.
  self.c = container;

  // Archive retention sweeper — age-based auto-purge of archived subtree roots
  // through the real purgeWorker cascade. Boot tick + hourly interval (the
  // worktree reaper pattern); retention is read from config at each tick, so a
  // config.json edit + reloadConfig takes effect without a restart. Fully
  // synchronous, so no in-flight guard is needed. "off" (the default) no-ops.
  const ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
  const archiveSweepTick = (): void => {
    try {
      const purged = purgeExpiredArchives(archivePurgeDeps(container), config.archive.retention);
      if (purged.length) log.info("archive retention sweep purged", { retention: config.archive.retention, purged });
    } catch (e) {
      log.warn("archive retention sweep failed", { error: errMsg(e) });
    }
  };
  archiveSweepTick();
  setInterval(archiveSweepTick, ARCHIVE_SWEEP_INTERVAL_MS).unref();

  return container;
}

export type Container = ReturnType<typeof buildContainer>;
