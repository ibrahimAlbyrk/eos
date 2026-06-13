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
import { errMsg } from "../../contracts/src/util.ts";
import type { AgentMcpConfig } from "../../core/src/domain/mcp-resolution.ts";

export interface ModelPrice { in: number; out: number; cacheRead: number; cacheCreate: number; cacheCreate1h: number; }

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
  // Named backend profiles + per-role defaults. claude-cli everywhere by
  // default → absent config = today's behavior.
  backends: Record<string, BackendProfile>;
  defaults: {
    orchestrator: { backend: string };
    worker: { backend: string };
  };
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
  "claude-cli-opus": { kind: "claude-cli", model: "opus", costMode: "included" },
  "claude-cli-sonnet": { kind: "claude-cli", model: "sonnet", costMode: "included" },
  "claude-cli-haiku": { kind: "claude-cli", model: "haiku", costMode: "included" },
};

function defaults(): DaemonConfig {
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
    permissions: {
      defaultTtlMs: envNum("EOS_PERMISSION_TTL_MS", 0),
    },
    prices: DEFAULT_PRICES,
    mcp: {
      orchestrator: { ...DEFAULT_AGENT_MCP },
      worker: { ...DEFAULT_AGENT_MCP },
    },
    backends: { ...DEFAULT_BACKENDS },
    defaults: {
      orchestrator: { backend: "claude-cli-opus" },
      worker: { backend: "claude-cli-opus" },
    },
  };
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
  extra: z.record(z.string(), McpServerDefSchema),
}).partial();

const DaemonConfigOverrideSchema = z.object({
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
  permissions: z.object({
    defaultTtlMs: z.number().int().positive(),
  }).partial().optional(),
  prices: z.record(z.string(), ModelPriceOverrideSchema).optional(),
  mcp: z.object({
    orchestrator: AgentMcpConfigOverrideSchema.optional(),
    worker: AgentMcpConfigOverrideSchema.optional(),
  }).partial().optional(),
  backends: z.record(z.string(), BackendProfileSchema).optional(),
  defaults: z.object({
    orchestrator: z.object({ backend: z.string() }).partial(),
    worker: z.object({ backend: z.string() }).partial(),
  }).partial().optional(),
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
