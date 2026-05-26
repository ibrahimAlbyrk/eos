// Centralized configuration for the daemon + worker + cli. Precedence:
//   env var → ~/.claude-mgr/config.json → built-in defaults
//
// Adding a new tunable: append a field below, give it a sensible default, and
// (optionally) wire an env var override. Everything is overridable; nothing
// behind this layer should be hard-coded in daemon.ts/worker.ts/cli.ts.

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { NotificationConfigSchema, type NotificationConfig } from "../../contracts/src/notifications.ts";

export interface ModelPrice { in: number; out: number; cacheRead: number; cacheCreate: number; }

export interface DaemonConfig {
  daemon: {
    host: string;
    port: number;
    home: string;            // ~/.claude-mgr
    logDir: string;          // ~/.claude-mgr/logs
    pidFile: string;         // ~/.claude-mgr/daemon.pid
    dbFile: string;          // ~/.claude-mgr/state.db
    sseKeepaliveMs: number;
  };
  paths: {
    repoRoot: string;        // root of this repository
    claudeBin: string;       // path to `claude` CLI (or just "claude" for PATH lookup)
    bunBin: string;          // path to `bun` (used by gateway MCP)
    workerScript: string;    // <repoRoot>/spawner/worker.ts
  };
  worker: {
    portRangeStart: number;
    portRangeEnd: number;
    heartbeatMs: number;
    heartbeatQuietMs: number;
    shutdownGraceMs: number;
    ptyWriteDelayMs: number;
  };
  permissions: {
    defaultTtlMs: number;
  };
  prices: Record<string, ModelPrice>;
  notifications: NotificationConfig;
}

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
// Cache-read is heavily discounted (~10% of input); cache-create is a slight
// premium. Override in config.json under `prices` if Anthropic changes them.
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  opus:   { in: 15.0, out: 75.0, cacheRead: 1.50, cacheCreate: 18.75 },
  sonnet: { in:  3.0, out: 15.0, cacheRead: 0.30, cacheCreate:  3.75 },
  haiku:  { in:  1.0, out:  5.0, cacheRead: 0.10, cacheCreate:  1.25 },
};

function defaults(): DaemonConfig {
  const repoRoot = envStr("CLAUDE_MGR_REPO_ROOT", detectRepoRoot());
  const home = envStr("CLAUDE_MGR_HOME", join(homedir(), ".claude-mgr"));
  return {
    daemon: {
      host: envStr("CLAUDE_MGR_HOST", "127.0.0.1"),
      port: envNum("CLAUDE_MGR_PORT", 7400),
      home,
      logDir: join(home, "logs"),
      pidFile: join(home, "daemon.pid"),
      dbFile: join(home, "state.db"),
      sseKeepaliveMs: envNum("CLAUDE_MGR_SSE_KEEPALIVE_MS", 25000),
    },
    paths: {
      repoRoot,
      claudeBin: envStr("CLAUDE_MGR_CLAUDE_BIN", "claude"),
      bunBin: envStr("CLAUDE_MGR_BUN_BIN", "bun"),
      workerScript: join(repoRoot, "spawner", "worker.ts"),
    },
    worker: {
      portRangeStart: envNum("CLAUDE_MGR_WORKER_PORT_START", 7500),
      portRangeEnd: envNum("CLAUDE_MGR_WORKER_PORT_END", 7699),
      heartbeatMs: envNum("CLAUDE_MGR_HEARTBEAT_MS", 8000),
      heartbeatQuietMs: envNum("CLAUDE_MGR_HEARTBEAT_QUIET_MS", 6000),
      shutdownGraceMs: envNum("CLAUDE_MGR_SHUTDOWN_GRACE_MS", 2500),
      ptyWriteDelayMs: envNum("CLAUDE_MGR_PTY_WRITE_DELAY_MS", 300),
    },
    permissions: {
      defaultTtlMs: envNum("CLAUDE_MGR_PERMISSION_TTL_MS", 30000),
    },
    prices: DEFAULT_PRICES,
    notifications: NotificationConfigSchema.parse({}),
  };
}

const ModelPriceOverrideSchema = z.object({
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheCreate: z.number().nonnegative(),
}).partial();

const DaemonConfigOverrideSchema = z.object({
  daemon: z.object({
    host: z.string(),
    port: z.number().int().positive(),
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
  }).partial().optional(),
  permissions: z.object({
    defaultTtlMs: z.number().int().positive(),
  }).partial().optional(),
  prices: z.record(z.string(), ModelPriceOverrideSchema).optional(),
  notifications: NotificationConfigSchema.optional(),
}).passthrough();

// Shallow-merge file-loaded overrides on top of defaults. Nested keys are
// overridden one level deep — enough for our flat-ish structure.
function mergeConfig(base: DaemonConfig, override: unknown): DaemonConfig {
  if (!override || typeof override !== "object") return base;
  const out: DaemonConfig = JSON.parse(JSON.stringify(base));
  const o = override as Record<string, unknown>;
  for (const k of Object.keys(out) as Array<keyof DaemonConfig>) {
    const incoming = o[k];
    if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
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
 *   env var  →  ~/.claude-mgr/config.json  →  built-in defaults
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
      console.log(`[config] failed to parse ${path}: ${(e as Error).message} — ignoring`);
    }
  }
  cached = deepFreeze(mergeConfig(base, override));
  // Best-effort: ensure ~/.claude-mgr exists so callers can write logs/pid.
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
 * `~/.claude-mgr/config.json` as a starting point for hand-editing. Used by
 * `eos config init`. Returns the path it wrote to.
 */
export function writeDefaultConfig(): string {
  const cfg = loadConfig();
  const path = join(cfg.daemon.home, "config.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2));
  return path;
}
