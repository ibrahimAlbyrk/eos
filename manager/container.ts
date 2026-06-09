// Composition root for the daemon. Wires every port to its concrete adapter
// in one place. Routes/middleware receive the container instead of reaching
// into module-scope globals.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";

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
import type { AgentEvent } from "../contracts/src/canonical.ts";
import { runMigrations, maybeVacuum } from "../infra/src/persistence/MigrationRunner.ts";
import { SqliteWorkerRepo } from "../infra/src/persistence/SqliteWorkerRepo.ts";
import { SqliteEventRepo } from "../infra/src/persistence/SqliteEventRepo.ts";
import { SqlitePendingRepo } from "../infra/src/persistence/SqlitePendingRepo.ts";
import { httpWorkerClient } from "../infra/src/ipc/HttpWorkerClient.ts";
import { loadPolicy } from "../infra/src/policy/YamlPolicyLoader.ts";
import { createDarwinFsHelpers, type FsHelpers } from "../infra/src/filesystem/DarwinFsHelpers.ts";
import { noopFsHelpers } from "../infra/src/filesystem/NoopFsHelpers.ts";
import { childProcessGitInfo } from "../infra/src/git/ChildProcessGitInfo.ts";
import { childProcessWorktreeManager } from "../infra/src/git/ChildProcessWorktreeManager.ts";
import { createChildProcessBranchIntegration } from "../infra/src/git/ChildProcessBranchIntegration.ts";
import { childProcessBranchPush } from "../infra/src/git/ChildProcessBranchPush.ts";
import { JsonRecentsRepo } from "../infra/src/persistence/JsonRecentsRepo.ts";
import { FileMcpServerCatalog } from "../infra/src/mcp/FileMcpServerCatalog.ts";
import { pruneOrphanWorktrees } from "../core/src/use-cases/PruneOrphanWorktrees.ts";
import { reconcileWorkersOnBoot } from "../core/src/use-cases/ReconcileWorkersOnBoot.ts";
import { resolveMcpServers } from "../core/src/domain/mcp-resolution.ts";

import type { Policy } from "../core/src/domain/policy.ts";
import type { ModelCatalog } from "../core/src/ports/ModelCatalog.ts";
import { PolicyGatewayService } from "../core/src/services/PolicyGatewayService.ts";
import { SqlBackedModeResolver } from "../core/src/services/SqlBackedModeResolver.ts";
import { SqlBackedBackendResolver } from "../core/src/services/SqlBackedBackendResolver.ts";
import { SseBroadcaster } from "./sse/SseBroadcaster.ts";
import { TurnSettleService } from "./services/TurnSettleService.ts";
import { PromptTemplateService } from "./services/PromptTemplateService.ts";
import { UserTemplateService } from "./services/UserTemplateService.ts";
import { UserSettingsService } from "./services/UserSettingsService.ts";
import { ModelCatalogService } from "./services/ModelCatalogService.ts";
import { PendingQuestionService } from "./services/PendingQuestionService.ts";

import type { SpawnWorkerSpec, SpawnWorkerDeps } from "../core/src/use-cases/SpawnWorker.ts";
export { randomOrchestratorName } from "./shared/names.ts";

export function buildContainer() {
  let config: DaemonConfig = loadConfig();
  const log = createLogger("daemon");

  // PID file ----------------------------------------------------------------
  try { writeFileSync(config.daemon.pidFile, String(process.pid)); } catch {}

  // DB backup before opening ------------------------------------------------
  if (existsSync(config.daemon.dbFile)) {
    try {
      const backupDir = join(config.daemon.home, "backups");
      mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const dst = join(backupDir, `state.db.${stamp}.bak`);
      copyFileSync(config.daemon.dbFile, dst);
      const all = readdirSync(backupDir)
        .filter((n) => n.startsWith("state.db.") && n.endsWith(".bak"))
        .map((n) => ({ n, t: statSync(join(backupDir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const old of all.slice(5)) {
        try { unlinkSync(join(backupDir, old.n)); } catch {}
      }
    } catch (e) {
      process.stderr.write(`[daemon] backup skipped: ${errMsg(e)}\n`);
    }
  }

  // Open DB + run migrations -----------------------------------------------
  const db = new DatabaseSync(config.daemon.dbFile);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, log);
  maybeVacuum(db, log, "startup");
  setInterval(() => maybeVacuum(db, log, "scheduled"), 60 * 60 * 1000).unref();

  // Repos -------------------------------------------------------------------
  const workers = new SqliteWorkerRepo(db);
  const events = new SqliteEventRepo(db);
  const pending = new SqlitePendingRepo(db);

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
  const plansDir = join(expandPath(process.env.CLAUDE_CONFIG_DIR ?? "~/.claude")!, "plans");
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

  // Git info + recents -----------------------------------------------------
  const git = childProcessGitInfo;
  const worktrees = childProcessWorktreeManager;
  const branchPush = childProcessBranchPush;
  const branchIntegration = createChildProcessBranchIntegration({
    triesDir: join(config.daemon.home, "tries"),
    now: () => systemClock.now(),
  });
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

  const buildEnv: SpawnWorkerDeps["buildEnv"] = () => ({
    ...(process.env as Record<string, string>),
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

  const buildMcpBuiltins = (input: {
    id: string;
    isOrchestrator: boolean;
    withGateway: boolean;
    parentId: string | undefined;
  }): { builtins: Record<string, unknown>; permissionPromptTool: string | undefined } => {
    const baseEnv = {
      ...process.env,
      EOS_DAEMON_URL: `http://127.0.0.1:${config.daemon.port}`,
      EOS_WORKER_ID: input.id,
    };
    const node = (script: string) => ({
      command: "node",
      args: ["--no-warnings", "--experimental-strip-types", join(config.paths.repoRoot, "manager", script)],
      env: baseEnv,
      alwaysLoad: true,
    });
    const builtins: Record<string, unknown> = {};
    if (input.isOrchestrator) builtins.orchestrator = node("orchestrator-mcp.ts");
    if (input.withGateway) {
      builtins.gateway = {
        command: config.paths.bunBin,
        args: ["run", join(config.paths.repoRoot, "gateway", "server.ts")],
        env: baseEnv,
      };
    }
    if (input.parentId) builtins.worker = node("worker-mcp.ts");
    return { builtins, permissionPromptTool: input.withGateway ? "mcp__gateway__decide" : undefined };
  };

  const writeMcpConfig = (input: {
    id: string;
    cwd: string | undefined;
    isOrchestrator: boolean;
    withGateway: boolean;
    parentId: string | undefined;
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
    try {
      const p = mcpConfigPathFor(id);
      if (existsSync(p)) unlinkSync(p);
    } catch {}
  };

  const turnSettle = new TurnSettleService(systemClock);
  const pendingQuestions = new PendingQuestionService(systemClock, randomIdGenerator);
  const promptTemplates = new PromptTemplateService(config.paths.promptsDir);
  const userTemplates = new UserTemplateService(join(config.daemon.home, "templates"));
  const userSettings = new UserSettingsService(join(config.daemon.home, "settings.json"));
  const modelCatalog = new ModelCatalogService(join(config.daemon.home, "models.json"), systemClock);

  // Reaper — reject pending questions whose TTL has elapsed.
  setInterval(() => pendingQuestions.sweepExpired(systemClock.now()), 30_000).unref();

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
  });

  // anthropic-api backend — in-process, ToolRuntime-driven. Text-only for now
  // (the tool set is the documented expansion); needs ANTHROPIC_API_KEY at
  // runtime. Selecting it is opt-in via config; claude-cli stays the default.
  const anthropicBackend = createInProcessBackend("anthropic-api", (spec) => ({
    model: createAnthropicModelClient({ apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: spec.model }),
    tools: new Map(),
    gate: { async decide() { return { allow: true }; } },
  }));
  // OpenAI-compatible backends (OpenAI, Codex-via-API, or any compatible
  // endpoint via OPENAI_BASE_URL). Same in-process ToolRuntime path.
  const openaiEnv = (spec: { model: string }) => ({
    model: createOpenAIModelClient({ apiKey: process.env.OPENAI_API_KEY ?? "", model: spec.model, baseUrl: process.env.OPENAI_BASE_URL }),
    tools: new Map(),
    gate: { async decide() { return { allow: true }; } },
  });
  const openaiBackend = createInProcessBackend("openai", openaiEnv);
  const codexBackend = createInProcessBackend("codex", openaiEnv);
  const backendMap = new Map([
    ["claude-cli", claudeCliBackend],
    ["anthropic-api", anthropicBackend],
    ["openai", openaiBackend],
    ["codex", codexBackend],
  ]);
  const backends = {
    get(kind: string) { const b = backendMap.get(kind); if (!b) throw new Error(`unknown backend: ${kind}`); return b; },
    has(kind: string) { return backendMap.has(kind); },
  };
  // Route an in-process backend's canonical events into the daemon pipeline
  // (log as agent_event + drive the state machine), mirroring the HTTP ingest
  // path that out-of-process (claude-cli) workers use.
  const onAgentEvent = (workerId: string, event: AgentEvent): void =>
    processAgentSignal(
      { workers, events, bus, clock: systemClock, models, log, isSettling: (id) => turnSettle.isSettling(id), markSettling: (id) => turnSettle.mark(id) },
      workerId,
      event,
    );

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
    supervisor,
    portAllocator,
    httpWorkerClient,
    models,
    policyGateway,
    modeResolver,
    metrics,
    fs,
    git,
    worktrees,
    branchIntegration,
    branchPush,
    uiToken,
    recents,
    buildArgs,
    buildEnv,
    logFileFor,
    claudeCliBackend,
    backends,
    onAgentEvent,
    backendResolver,
    turnSettle,
    pendingQuestions,
    promptTemplates,
    userTemplates,
    userSettings,
    modelCatalog,
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
