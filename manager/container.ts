// Composition root for the daemon. Wires every port to its concrete adapter
// in one place. Routes/middleware receive the container instead of reaching
// into module-scope globals.

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";

import { loadConfig, type DaemonConfig, type ModelPrice } from "./shared/config.ts";

import { systemClock } from "../infra/src/time/SystemClock.ts";
import { randomIdGenerator } from "../infra/src/id/RandomIdGenerator.ts";
import { createLogger } from "../infra/src/observability/StructLogger.ts";
import { createInMemoryEventBus } from "../infra/src/eventbus/InMemoryEventBus.ts";
import { createPortAllocator } from "../infra/src/net/PortAllocator.ts";
import { createChildProcessSupervisor } from "../infra/src/supervision/ChildProcessSupervisor.ts";
import { runMigrations, maybeVacuum } from "../infra/src/persistence/MigrationRunner.ts";
import { SqliteWorkerRepo } from "../infra/src/persistence/SqliteWorkerRepo.ts";
import { SqliteEventRepo } from "../infra/src/persistence/SqliteEventRepo.ts";
import { SqlitePendingRepo } from "../infra/src/persistence/SqlitePendingRepo.ts";
import { httpWorkerClient } from "../infra/src/ipc/HttpWorkerClient.ts";
import { loadPolicy } from "../infra/src/policy/YamlPolicyLoader.ts";
import { createDarwinFsHelpers, type FsHelpers } from "../infra/src/filesystem/DarwinFsHelpers.ts";
import { noopFsHelpers } from "../infra/src/filesystem/NoopFsHelpers.ts";
import { childProcessGitInfo } from "../infra/src/git/ChildProcessGitInfo.ts";
import { JsonRecentsRepo } from "../infra/src/persistence/JsonRecentsRepo.ts";

import type { Policy } from "../core/src/domain/policy.ts";
import type { ModelCatalog } from "../core/src/ports/ModelCatalog.ts";
import { PolicyGatewayService } from "../core/src/services/PolicyGatewayService.ts";
import { LimitsEnforcer } from "../core/src/services/LimitsEnforcer.ts";
import { SseBroadcaster } from "./sse/SseBroadcaster.ts";

import type { SpawnWorkerSpec, SpawnWorkerDeps } from "../core/src/use-cases/SpawnWorker.ts";
export { randomOrchestratorName } from "./shared/names.ts";

export function buildContainer() {
  const config: DaemonConfig = loadConfig();
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
      process.stderr.write(`[daemon] backup skipped: ${(e as Error).message}\n`);
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

  // Orphan worktree scan — log-only, never deletes.
  for (const r of workers.listAll()) {
    if (r.worktree_from && !existsSync(r.worktree_from)) {
      log.warn("worker references missing worktree path", {
        worker: r.id, path: r.worktree_from, branch: r.branch,
      });
    }
  }

  // Bus + SSE ---------------------------------------------------------------
  const bus = createInMemoryEventBus();
  const sse = new SseBroadcaster({ bus, keepaliveMs: config.daemon.sseKeepaliveMs });

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

  // Policy gateway service --------------------------------------------------
  const policyGateway = new PolicyGatewayService({
    pending, events, bus, clock: systemClock, ids: randomIdGenerator,
    getPolicy: () => policy,
    onDecision: (behavior) => {
      if (behavior === "allow") metrics.policyAllow++;
      else if (behavior === "deny") metrics.policyDeny++;
      else metrics.policyAsk++;
    },
  });

  // Limits enforcer ---------------------------------------------------------
  const limitsEnforcer = new LimitsEnforcer({
    workers, events, bus, supervisor,
    clock: systemClock,
    log: log.child({ scope: "limits" }),
  });
  setInterval(() => limitsEnforcer.sweep(), 30_000).unref();

  // FS helpers (platform-specific) -----------------------------------------
  const fs: FsHelpers = process.platform === "darwin"
    ? createDarwinFsHelpers({
        helperScript: join(config.paths.repoRoot, "manager", "scripts", "macos-default-app.swift"),
        iconCacheDir: join(config.daemon.home, "icon-cache"),
      })
    : noopFsHelpers;

  // Git info + recents -----------------------------------------------------
  const git = childProcessGitInfo;
  const recents = new JsonRecentsRepo(join(config.daemon.home, "recents.json"));

  // SpawnWorker dep builders -----------------------------------------------
  const buildArgs: SpawnWorkerDeps["buildArgs"] = ({ id, port, spec, model }) => {
    const args = [
      "--experimental-strip-types",
      "--no-warnings",
      config.paths.workerScript,
      "--daemon-url", `http://127.0.0.1:${config.daemon.port}`,
      "--worker-id", id,
      "--port", String(port),
    ];
    if (spec.prompt && spec.prompt.trim().length > 0) {
      args.push("--prompt", spec.prompt);
    }
    if (spec.cwd) args.push("--cwd", spec.cwd);
    if (spec.worktreeFrom) args.push("--worktree-from", spec.worktreeFrom);
    if (spec.branch) args.push("--branch", spec.branch);
    if (spec.name) args.push("--name", spec.name);
    if (spec.parentId) args.push("--parent-id", spec.parentId);
    if (spec.withGateway) args.push("--with-gateway");
    if (spec.persistent) args.push("--persistent");
    if (spec.systemPromptFile) args.push("--system-prompt-file", spec.systemPromptFile);
    if (spec.mcpConfig) args.push("--mcp-config", spec.mcpConfig);
    if (spec.permissionPromptTool) args.push("--permission-prompt-tool", spec.permissionPromptTool);
    if (spec.claudePermissionMode) args.push("--claude-permission-mode", spec.claudePermissionMode);
    args.push("--model", model);
    if (spec.effort) args.push("--effort", spec.effort);
    return args;
  };

  const buildEnv: SpawnWorkerDeps["buildEnv"] = () => ({
    ...(process.env as Record<string, string>),
    CLAUDE_MGR_CLAUDE_BIN: config.paths.claudeBin,
    CLAUDE_MGR_BUN_BIN: config.paths.bunBin,
    CLAUDE_MGR_REPO_ROOT: config.paths.repoRoot,
    CLAUDE_MGR_GATEWAY_SCRIPT: join(config.paths.repoRoot, "gateway", "server.ts"),
  });

  const logFileFor = (id: string): string => join(config.daemon.logDir, `${id}.log`);

  // Per-orchestrator MCP config writer (used by /orchestrators POST and
  // cleaned up by KillWorker via postKillCleanup).
  const writeOrchestratorMcpConfig = (orchId: string): string => {
    const mcpPath = join(config.daemon.home, `orchestrator-mcp-${orchId}.json`);
    writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          orchestrator: {
            command: "node",
            args: ["--no-warnings", "--experimental-strip-types", join(config.paths.repoRoot, "manager", "orchestrator-mcp.ts")],
            env: {
              ...process.env,
              CLAUDE_MGR_DAEMON_URL: `http://127.0.0.1:${config.daemon.port}`,
              CLAUDE_MGR_WORKER_ID: orchId,
            },
          },
        },
      }),
    );
    return mcpPath;
  };

  const cleanupOrchestratorMcpConfig = (id: string): void => {
    try {
      const mcpPath = join(config.daemon.home, `orchestrator-mcp-${id}.json`);
      if (existsSync(mcpPath)) unlinkSync(mcpPath);
    } catch {}
  };

  return {
    config,
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
    limitsEnforcer,
    metrics,
    fs,
    git,
    recents,
    buildArgs,
    buildEnv,
    logFileFor,
    writeOrchestratorMcpConfig,
    cleanupOrchestratorMcpConfig,
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
  };
}

export type Container = ReturnType<typeof buildContainer>;
