// Centralized configuration for the daemon + worker + cli. Precedence:
//   env var → ~/.eos/config.json → built-in defaults
//
// Adding a new tunable: append a field below, give it a sensible default, and
// (optionally) wire an env var override. Everything is overridable; nothing
// behind this layer should be hard-coded in daemon.ts/worker.ts/cli.ts.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServerDefSchema } from "../../contracts/src/shared.ts";
import { type BackendProfile, BackendProfileSchema } from "../../contracts/src/backend.ts";
import { MemorySourceSchema, type MemorySourceSpec } from "../../contracts/src/memory.ts";
import { RemoteConfigSchema, type RemoteConfig, type RemoteMode } from "../../contracts/src/remote.ts";
import { errMsg } from "../../contracts/src/util.ts";
import type { AgentMcpConfig } from "../../core/src/domain/mcp-resolution.ts";

export interface ModelPrice { in: number; out: number; cacheRead: number; cacheCreate: number; cacheCreate1h: number; }

// Per-task tunables for the micro-task subsystem (config.microTasks.tasks[id]).
// charLimit bounds the inputs a task feeds its prompt; promptTemplate, when set,
// overrides the catalog prompt with an inline body.
export interface MicroTaskCfg {
  enabled: boolean;
  delayMs: number;
  model: string;
  charLimit: number;
  promptTemplate?: string;
}

export interface DaemonConfig {
  daemon: {
    host: string;
    port: number;
    rawPort: number;         // raw-content origin (fs-raw + pdf.js viewer)
    home: string;            // ~/.eos
    logDir: string;          // ~/.eos/logs
    pidFile: string;         // ~/.eos/daemon.pid
    dbFile: string;          // ~/.eos/state.db
    sseKeepaliveMs: number;
  };
  paths: {
    repoRoot: string;        // root of this repository
    claudeBin: string;       // path to `claude` CLI (or just "claude" for PATH lookup)
    bunBin: string;          // path to `bun` (used by gateway MCP)
    workerScript: string;    // <repoRoot>/spawner/worker.ts
    promptsDir: string;      // <repoRoot>/manager/prompts — DPI fragment + action-template library
    workerDefinitionsDir: string;  // <repoRoot>/manager/workers — built-in worker definition .md library
  };
  worker: {
    portRangeStart: number;
    portRangeEnd: number;
    heartbeatMs: number;
    heartbeatQuietMs: number;
    shutdownGraceMs: number;
    ptyWriteDelayMs: number;
    // Worktree hydration copies gitignored node_modules into fresh worktrees
    // unconditionally; .env* files carry secrets and are copied only when this
    // opt-in is set.
    hydrateEnvFiles: boolean;
  };
  // Per-worker event retention. The events table is append-only and otherwise
  // grows without bound (a persistent orchestrator never gets its rows culled);
  // each worker keeps only its newest maxPerWorker rows, older ones pruned.
  events: {
    maxPerWorker: number;
  };
  permissions: {
    defaultTtlMs: number;
  };
  prices: Record<string, ModelPrice>;
  // Per-agent-type MCP wiring. Defaults inherit all of claude's normal MCP
  // servers (standard behavior); narrow with include/exclude or add type-only
  // servers via extra. See core/src/domain/mcp-resolution.ts.
  mcp: {
    orchestrator: AgentMcpConfig;
    worker: AgentMcpConfig;
  };
  // Memory sources (CLAUDE.md, plus any AGENTS.md-style files the user declares)
  // injected into a worker's appended system prompt for backends that don't load
  // them natively. Keyed by source id; resolveMemorySources applies field
  // defaults. enabled=false turns off all injection.
  memory: {
    enabled: boolean;
    sources: Record<string, MemorySourceSpec>;
  };
  // Named backend profiles + per-role defaults. claude-cli everywhere by
  // default → absent config = today's behavior.
  backends: Record<string, BackendProfile>;
  defaults: {
    orchestrator: { backend: string };
    worker: { backend: string };
  };
  // Auto-update: the daemon polls the configured git remote and offers a newer
  // build to the app (banner + native launch splash). See UpdateService.
  updates: {
    enabled: boolean;
    checkIntervalMs: number;
  };
  // Dynamic loops. Defaults applied when a loop is attached without explicit
  // args, plus the safety + judge knobs. NO token/wall-clock budget — the
  // no-progress detector (noProgressWindow + stopOnNoProgress) is the only net
  // on an unbounded loop.
  loop: {
    enabled: boolean;
    // The default attempt cap when a loop is attached without an explicit limit.
    // null = UNBOUNDED out of the box (netted only by no-progress); set a number
    // to impose a default cap.
    maxAttempts: number | null;
    strategy: string;
    noProgressWindow: number;
    stopOnNoProgress: boolean;
    retryOnFailed: boolean;
    judge: { model: string; temperature: number };
  };
  // Deterministic workflow-orchestration engine (daemon-resident). `enabled`
  // gates the run path; `maxConcurrentSteps` is the per-run leaf-spawn cap fed to
  // the engine's ConcurrencyGate; `defaultStepTimeoutMs` is reserved (0 = no
  // step timeout enforced yet); `defaultScriptTimeoutMs` is the kill deadline a
  // `script` node uses when it sets no `timeoutMs` of its own (§ITEM 1).
  workflow: {
    enabled: boolean;
    maxConcurrentSteps: number;
    defaultStepTimeoutMs: number;
    defaultScriptTimeoutMs: number;
  };
  // Peer collaboration (collaborate: true workers). awaitTimeoutMs: how long an
  // ask_peer consult to a not-yet-spawned peer waits for that peer to join
  // before it declines (so a consumer spawned before its providers blocks rather
  // than failing, but never hangs forever on a peer that never arrives).
  collaborate: {
    awaitTimeoutMs: number;
  };
  // Daemon-side micro-tasks: small predetermined-prompt Haiku tasks triggered off
  // the EventBus (auto-naming is the first). `enabled` gates the whole subsystem;
  // `pauseMaxMs` is the drop-safety deadline that auto-resumes a paused run if a
  // cancel/resume is ever lost; per-task tunables live under `tasks`.
  microTasks: {
    enabled: boolean;
    pauseMaxMs: number;
    tasks: Record<string, MicroTaskCfg>;
  };
  // iOS remote-control edge (design §6). OFF by default — absent config = no
  // remote surface. The crypto/wire contract is docs/ios-remote-protocol.md.
  remote: RemoteConfig;
}

const DEFAULT_AGENT_MCP: AgentMcpConfig = {
  inheritDefaults: true,
  include: ["*"],
  exclude: [],
  extra: {},
};

// Walk up from this file's location to find the repo root. daemon.ts and
// worker.ts both live two levels below the repo root, so we resolve relative
// to this config module's directory.
function detectRepoRoot(): string {
  try {
    // shared/config.ts lives at <repoRoot>/manager/shared/config.ts
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "..", "..");
  } catch {
    // Last-ditch: cwd. Daemon usually starts from project root anyway.
    return process.cwd();
  }
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function envStr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// Default model prices mirror public Anthropic API rates (per million tokens).
// Cache-read is heavily discounted (10% of input); cacheCreate is 5-minute
// ephemeral writes (1.25× input); cacheCreate1h is 1-hour ephemeral writes
// (2× input). Override in config.json under `prices` if Anthropic changes them.
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  fable:  { in: 10.0, out: 50.0, cacheRead: 1.00, cacheCreate: 12.50, cacheCreate1h: 20.0 },
  opus:   { in: 15.0, out: 75.0, cacheRead: 1.50, cacheCreate: 18.75, cacheCreate1h: 30.0 },
  sonnet: { in:  3.0, out: 15.0, cacheRead: 0.30, cacheCreate:  3.75, cacheCreate1h:  6.0 },
  haiku:  { in:  1.0, out:  5.0, cacheRead: 0.10, cacheCreate:  1.25, cacheCreate1h:  2.0 },
};

const DEFAULT_BACKENDS: Record<string, BackendProfile> = {
  // claude-sdk is the default: subscription-billed, live thinking, in-process tools.
  // PTY (claude-cli) stays first-class and is the automatic fallback when the
  // subscription credential is absent (resolveSpawnBackend) — never silent metered billing.
  "claude-sdk-opus": {
    kind: "claude-sdk", model: "claude-opus-4-8",
    auth: { kind: "subscription" }, costMode: "included",
    params: { thinking: { type: "adaptive", display: "summarized" } },
  },
  "claude-cli-opus": { kind: "claude-cli", model: "opus", costMode: "included" },
  "claude-cli-sonnet": { kind: "claude-cli", model: "sonnet", costMode: "included" },
  "claude-cli-haiku": { kind: "claude-cli", model: "haiku", costMode: "included" },
};

// Exported for tests that must assert the BUILT-IN defaults independent of the
// user's ~/.eos/config.json (loadConfig merges that file on top).
export function defaults(): DaemonConfig {
  const repoRoot = envStr("EOS_REPO_ROOT", detectRepoRoot());
  const home = envStr("EOS_HOME", join(homedir(), ".eos"));
  return {
    daemon: {
      host: envStr("EOS_HOST", "127.0.0.1"),
      port: envNum("EOS_PORT", 7400),
      rawPort: envNum("EOS_RAW_PORT", 7401),
      home,
      logDir: join(home, "logs"),
      pidFile: join(home, "daemon.pid"),
      dbFile: join(home, "state.db"),
      sseKeepaliveMs: envNum("EOS_SSE_KEEPALIVE_MS", 25000),
    },
    paths: {
      repoRoot,
      claudeBin: envStr("EOS_CLAUDE_BIN", "claude"),
      bunBin: envStr("EOS_BUN_BIN", "bun"),
      workerScript: join(repoRoot, "spawner", "worker.ts"),
      promptsDir: envStr("EOS_PROMPTS_DIR", join(repoRoot, "manager", "prompts")),
      workerDefinitionsDir: envStr("EOS_WORKER_DEFINITIONS_DIR", join(repoRoot, "manager", "workers")),
    },
    worker: {
      portRangeStart: envNum("EOS_WORKER_PORT_START", 7500),
      portRangeEnd: envNum("EOS_WORKER_PORT_END", 7699),
      heartbeatMs: envNum("EOS_HEARTBEAT_MS", 8000),
      heartbeatQuietMs: envNum("EOS_HEARTBEAT_QUIET_MS", 6000),
      shutdownGraceMs: envNum("EOS_SHUTDOWN_GRACE_MS", 2500),
      ptyWriteDelayMs: envNum("EOS_PTY_WRITE_DELAY_MS", 300),
      hydrateEnvFiles: envStr("EOS_HYDRATE_ENV_FILES", "") === "1",
    },
    events: {
      maxPerWorker: envNum("EOS_EVENTS_MAX_PER_WORKER", 20000),
    },
    permissions: {
      defaultTtlMs: envNum("EOS_PERMISSION_TTL_MS", 0),
    },
    prices: DEFAULT_PRICES,
    mcp: {
      orchestrator: { ...DEFAULT_AGENT_MCP },
      worker: { ...DEFAULT_AGENT_MCP },
    },
    memory: {
      enabled: true,
      sources: {
        // The repo's only built-in source. Both claude lanes auto-load it now
        // (assumeNativeFor): claude-cli always did, and claude-sdk does too since
        // its settingSources include "project" — so selectInjectableMemory drops it
        // for both and never double-injects. Add AGENTS.md or other sources by
        // dropping entries here in ~/.eos/config.json — no code change.
        claude: {
          enabled: true,
          label: "CLAUDE.md",
          userPaths: ["~/.claude/CLAUDE.md"],
          projectFilenames: ["CLAUDE.md"],
          priority: 0,
          assumeNativeFor: ["claude-cli", "claude-sdk"],
        },
      },
    },
    backends: { ...DEFAULT_BACKENDS },
    defaults: {
      orchestrator: { backend: "claude-sdk-opus" },
      worker: { backend: "claude-sdk-opus" },
    },
    updates: {
      enabled: envStr("EOS_UPDATES_ENABLED", "1") !== "0",
      checkIntervalMs: envNum("EOS_UPDATES_CHECK_INTERVAL_MS", 30 * 60 * 1000),
    },
    loop: {
      enabled: false,
      maxAttempts: null,
      strategy: "hybrid",
      noProgressWindow: 3,
      stopOnNoProgress: true,
      retryOnFailed: false,
      judge: { model: "sonnet", temperature: 0.1 },
    },
    workflow: {
      enabled: true,
      maxConcurrentSteps: 8,
      defaultStepTimeoutMs: 0,
      defaultScriptTimeoutMs: 30000,
    },
    collaborate: {
      awaitTimeoutMs: envNum("EOS_COLLABORATE_AWAIT_TIMEOUT_MS", 120000),
    },
    microTasks: {
      enabled: true,
      pauseMaxMs: 10000,
      tasks: {
        "auto-name": { enabled: true, delayMs: 5000, model: "haiku", charLimit: 280 },
      },
    },
    remote: {
      // OFF by default. The rate-limit + lease defaults below only take effect
      // once an operator arms remote (mode=lan|relay) in ~/.eos/config.json.
      mode: parseRemoteMode(envStr("EOS_REMOTE_MODE", "off")),
      inactivityLeaseMs: envNum("EOS_REMOTE_LEASE_MS", 30 * 60 * 1000),
      rateLimit: { perDevicePerMin: 120, globalPerMin: 600, pairingPerMin: 5 },
    },
  };
}

function parseRemoteMode(v: string): RemoteMode {
  return v === "lan" || v === "relay" ? v : "off";
}

const ModelPriceOverrideSchema = z.object({
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheCreate: z.number().nonnegative(),
  cacheCreate1h: z.number().nonnegative(),
}).partial();

const AgentMcpConfigOverrideSchema = z.object({
  inheritDefaults: z.boolean(),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  extra: z.record(McpServerDefSchema), // 1-arg: McpServerDefSchema is contracts' zod (see backends note below)
}).partial();

export const DaemonConfigOverrideSchema = z.object({
  daemon: z.object({
    host: z.string(),
    port: z.number().int().positive(),
    rawPort: z.number().int().positive(),
    home: z.string(),
    sseKeepaliveMs: z.number().int().positive(),
  }).partial().optional(),
  paths: z.object({
    repoRoot: z.string(),
    claudeBin: z.string(),
    bunBin: z.string(),
  }).partial().optional(),
  worker: z.object({
    portRangeStart: z.number().int().positive(),
    portRangeEnd: z.number().int().positive(),
    heartbeatMs: z.number().int().positive(),
    heartbeatQuietMs: z.number().int().positive(),
    shutdownGraceMs: z.number().int().positive(),
    ptyWriteDelayMs: z.number().int().nonnegative(),
    hydrateEnvFiles: z.boolean(),
  }).partial().optional(),
  events: z.object({
    // nonnegative, not positive: 0 is the documented "disable pruning" value
    // (matches the env path + SqliteEventRepo's <= 0 guard).
    maxPerWorker: z.number().int().nonnegative(),
  }).partial().optional(),
  permissions: z.object({
    defaultTtlMs: z.number().int().positive(),
  }).partial().optional(),
  prices: z.record(z.string(), ModelPriceOverrideSchema).optional(),
  mcp: z.object({
    orchestrator: AgentMcpConfigOverrideSchema.optional(),
    worker: AgentMcpConfigOverrideSchema.optional(),
  }).partial().optional(),
  memory: z.object({
    enabled: z.boolean(),
    // 1-arg z.record: MemorySourceSchema is contracts' zod — see the backends note.
    sources: z.record(MemorySourceSchema),
  }).partial().optional(),
  // Single-arg z.record(valueType): the 2-arg form detects its overload via
  // `valueType instanceof ZodType`, which fails across separate physical zod
  // copies (manager/ vs contracts/) and silently collapses the value type to
  // string. BackendProfileSchema is built by contracts' zod — keep it 1-arg.
  backends: z.record(BackendProfileSchema).optional(),
  defaults: z.object({
    orchestrator: z.object({ backend: z.string() }).partial(),
    worker: z.object({ backend: z.string() }).partial(),
  }).partial().optional(),
  updates: z.object({
    enabled: z.boolean(),
    checkIntervalMs: z.number().int().positive(),
  }).partial().optional(),
  loop: z.object({
    enabled: z.boolean(),
    maxAttempts: z.number().int().nonnegative().nullable(),
    strategy: z.string(),
    noProgressWindow: z.number().int().positive(),
    stopOnNoProgress: z.boolean(),
    retryOnFailed: z.boolean(),
    judge: z.object({ model: z.string(), temperature: z.number() }).partial(),
  }).partial().optional(),
  workflow: z.object({
    enabled: z.boolean(),
    maxConcurrentSteps: z.number().int().positive(),
    defaultStepTimeoutMs: z.number().int().nonnegative(),
    defaultScriptTimeoutMs: z.number().int().nonnegative(),
  }).partial().optional(),
  collaborate: z.object({
    awaitTimeoutMs: z.number().int().positive(),
  }).partial().optional(),
  microTasks: z.object({
    enabled: z.boolean(),
    pauseMaxMs: z.number().int().positive(),
    // 1-arg z.record(valueSchema): the value schema is a local zod object, but
    // keep the 1-arg form anyway — see the backends note above re: the 2-arg trap.
    tasks: z.record(z.object({
      enabled: z.boolean(),
      delayMs: z.number().int().nonnegative(),
      model: z.string(),
      charLimit: z.number().int().positive(),
      promptTemplate: z.string(),
    }).partial()),
  }).partial().optional(),
  // mode optional on override (.partial) so a config.json may set just relay
  // topology without restating mode; mergeConfig field-merges over the default.
  remote: RemoteConfigSchema.partial().optional(),
}).passthrough();

// Merge file-loaded overrides on top of defaults. Most sections are flat and
// merged one level deep. `prices` is special-cased: it's a two-level map
// (model → {in,out,cacheRead,cacheCreate,cacheCreate1h}) and a partial
// override like `{ sonnet: { in: 4 } }` must preserve the other 4 fields
// instead of wiping them — otherwise computeCostUsd produces NaN.
function mergeConfig(base: DaemonConfig, override: unknown): DaemonConfig {
  if (!override || typeof override !== "object") return base;
  const out: DaemonConfig = JSON.parse(JSON.stringify(base));
  const o = override as Record<string, unknown>;
  for (const k of Object.keys(out) as Array<keyof DaemonConfig>) {
    const incoming = o[k];
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) continue;
    if (k === "prices") {
      const incPrices = incoming as Record<string, Partial<ModelPrice>>;
      for (const model of Object.keys(incPrices)) {
        const base = out.prices[model] ?? { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
        out.prices[model] = { ...base, ...incPrices[model] };
      }
    } else if (k === "mcp") {
      // Two-level (orchestrator|worker → AgentMcpConfig). Merge per agent,
      // per field so overriding just `worker.include` keeps the other fields.
      const incMcp = incoming as Record<string, Partial<AgentMcpConfig>>;
      for (const t of ["orchestrator", "worker"] as const) {
        if (incMcp[t]) out.mcp[t] = { ...out.mcp[t], ...incMcp[t] };
      }
    } else if (k === "memory") {
      // enabled flag + per-id source field-merge (adding `agents` keeps the
      // built-in `claude`; overriding `claude.userPaths` keeps its other fields).
      const incMem = incoming as { enabled?: boolean; sources?: Record<string, Partial<MemorySourceSpec>> };
      if (typeof incMem.enabled === "boolean") out.memory.enabled = incMem.enabled;
      if (incMem.sources) {
        for (const id of Object.keys(incMem.sources)) {
          out.memory.sources[id] = { ...(out.memory.sources[id] ?? {}), ...incMem.sources[id] };
        }
      }
    } else if (k === "backends") {
      // Per-profile replace — a profile is atomic (kind drives everything).
      const incB = incoming as Record<string, BackendProfile>;
      for (const name of Object.keys(incB)) out.backends[name] = incB[name];
    } else if (k === "defaults") {
      // Per-role field merge (setting just worker.backend keeps orchestrator).
      const incD = incoming as Record<string, { backend?: string }>;
      for (const role of ["orchestrator", "worker"] as const) {
        const b = incD[role]?.backend;
        if (b) out.defaults[role] = { backend: b };
      }
    } else if (k === "loop") {
      // Top-level field merge + nested judge field merge (overriding just
      // judge.model keeps the temperature).
      const { judge, ...rest } = incoming as Partial<DaemonConfig["loop"]>;
      Object.assign(out.loop, rest);
      if (judge) out.loop.judge = { ...out.loop.judge, ...judge };
    } else if (k === "workflow") {
      // Flat field merge (overriding just maxConcurrentSteps keeps enabled).
      Object.assign(out.workflow, incoming as Partial<DaemonConfig["workflow"]>);
    } else if (k === "microTasks") {
      // Subsystem flags + per-task field merge (overriding just auto-name.model
      // keeps its delayMs/charLimit; a new task id supplies its own full config).
      const incMt = incoming as { enabled?: boolean; pauseMaxMs?: number; tasks?: Record<string, Partial<MicroTaskCfg>> };
      if (typeof incMt.enabled === "boolean") out.microTasks.enabled = incMt.enabled;
      if (typeof incMt.pauseMaxMs === "number") out.microTasks.pauseMaxMs = incMt.pauseMaxMs;
      if (incMt.tasks) {
        for (const id of Object.keys(incMt.tasks)) {
          out.microTasks.tasks[id] = { ...(out.microTasks.tasks[id] ?? {}), ...incMt.tasks[id] } as MicroTaskCfg;
        }
      }
    } else {
      Object.assign(out[k] as Record<string, unknown>, incoming as Record<string, unknown>);
    }
  }
  return out;
}

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(obj);
}

let cached: DaemonConfig | null = null;

/**
 * Loads (and memoizes) the active daemon config. Precedence is:
 *
 *   env var  →  ~/.eos/config.json  →  built-in defaults
 *
 * Safe to call from any module entry — the cached value is reused on
 * subsequent calls so daemon, cli, and worker share an identical view.
 * Errors reading or parsing the override file are logged and dropped (the
 * defaults still apply) so a broken config can never block daemon startup.
 */
export function loadConfig(): DaemonConfig {
  if (cached) return cached;
  const base = defaults();
  const path = join(base.daemon.home, "config.json");
  let override: unknown = null;
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      const result = DaemonConfigOverrideSchema.safeParse(raw);
      if (!result.success) {
        console.log(`[config] invalid config in ${path}: ${result.error.message} — ignoring`);
      } else {
        override = result.data;
        console.log(`[config] overrides loaded from ${path}`);
      }
    } catch (e) {
      console.log(`[config] failed to parse ${path}: ${errMsg(e)} — ignoring`);
    }
  }
  cached = deepFreeze(mergeConfig(base, override));
  // Best-effort: ensure ~/.eos exists so callers can write logs/pid.
  try { mkdirSync(cached.daemon.home, { recursive: true }); } catch {}
  try { mkdirSync(cached.daemon.logDir, { recursive: true }); } catch {}
  return cached;
}

export function reloadConfig(): DaemonConfig {
  cached = null;
  return loadConfig();
}

/**
 * Writes the active merged config (defaults + env + existing file) back to
 * `~/.eos/config.json` as a starting point for hand-editing. Used by
 * `eos config init`. Returns the path it wrote to.
 */
export function writeDefaultConfig(): string {
  const cfg = loadConfig();
  const path = join(cfg.daemon.home, "config.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}
