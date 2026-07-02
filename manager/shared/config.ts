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
import { isTieredPrice, type ModelPriceSpec, type PriceTier } from "../../core/src/domain/value-objects.ts";

export interface ModelPrice { in: number; out: number; cacheRead: number; cacheCreate: number; cacheCreate1h: number; }
// A config price is EITHER flat (the existing/LiteLLM shape) or context-tiered.
// Re-exported so consumers (container, routes) can accept both forms.
export type { ModelPriceSpec } from "../../core/src/domain/value-objects.ts";

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
  prices: Record<string, ModelPriceSpec>;
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
    // judge.temperature is IGNORED on the claude-sdk lane the judge runs on today
    // (the agent SDK surfaces only model/effort/thinking, not per-call
    // temperature — see LlmJudgeStrategy / AgentBackendJudgeClient). It is passed
    // through and becomes live only if/when the metered anthropic-api lane ships
    // (Fix 6f). Kept, not removed, to avoid churning the config schema.
    judge: { model: string; temperature: number };
  };
  // Deterministic workflow-orchestration engine (daemon-resident). `enabled`
  // gates the run path; `maxConcurrentSteps` is the per-run leaf-spawn cap fed to
  // the engine's ConcurrencyGate; `defaultStepTimeoutMs` is the per-step hang
  // backstop the spawn-join arms — the fail-closed guarantee that a step which
  // never calls workflow_step_output fails loudly instead of wedging the run, so
  // it MUST be > 0 (the schema rejects 0, falling back to this default);
  // `defaultScriptTimeoutMs` is the kill deadline a `script` node uses when it
  // sets no `timeoutMs` of its own (§ITEM 1).
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

// A Qwen input-tier band: Qwen bills NO cache discount (capabilities.cache:"none"),
// so every tier's cache rates are 0. `maxInputTokens` is the inclusive upper bound.
const qwenTier = (maxInputTokens: number | null, inR: number, outR: number): PriceTier => ({
  maxInputTokens,
  price: { in: inR, out: outR, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 },
});

// Default model prices (per million tokens). Anthropic SKUs mirror public API
// rates: cache-read ≈10% of input, cacheCreate is 5-minute ephemeral writes
// (1.25× input), cacheCreate1h is 1-hour writes (2× input). The non-Anthropic
// entries below are MANUAL overrides for provider models the LiteLLM auto-catalog
// either lacks or only carries behind a proxy SKU (wrong direct-API price): being in
// config.prices, they WIN over the catalog (priceForModel checks here first). Models
// the catalog prices correctly (OpenAI gpt-5.x, xAI grok-4.3, Kimi kimi-k2.6) are
// intentionally absent — they resolve automatically and self-update. Override any of
// these in config.json under `prices` (flat OR tiered).
const DEFAULT_PRICES: Record<string, ModelPriceSpec> = {
  fable:  { in: 10.0, out: 50.0, cacheRead: 1.00, cacheCreate: 12.50, cacheCreate1h: 20.0 },
  opus:   { in: 15.0, out: 75.0, cacheRead: 1.50, cacheCreate: 18.75, cacheCreate1h: 30.0 },
  sonnet: { in:  3.0, out: 15.0, cacheRead: 0.30, cacheCreate:  3.75, cacheCreate1h:  6.0 },
  haiku:  { in:  1.0, out:  5.0, cacheRead: 0.10, cacheCreate:  1.25, cacheCreate1h:  2.0 },

  // Zhipu GLM (Z.ai, international USD) — flat. LiteLLM only has Cloudflare/proxy
  // SKUs for these, whose price differs from the direct Z.ai API; set manually.
  "glm-5.2": { in: 1.40, out: 4.40, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 },
  "glm-4.7": { in: 0.60, out: 2.20, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 },

  // Alibaba Qwen (DashScope international USD) — TIERED on input-token count; absent
  // from LiteLLM. Bands/rates from model-research cluster-03. qwen3.7-max is a single
  // flat rate; plus/coder-plus scale with prompt size at the documented Qwen 128k/256k
  // native boundaries. Intermediate-tier rates interpolate the documented endpoint
  // range — refine in config.prices if Alibaba publishes finer bands.
  "qwen3.7-max": { tiers: [qwenTier(null, 2.5, 7.5)] },
  "qwen3.7-plus": { tiers: [qwenTier(128_000, 0.4, 1.6), qwenTier(256_000, 0.8, 3.2), qwenTier(null, 1.2, 4.8)] },
  "qwen3-coder-plus": { tiers: [qwenTier(256_000, 0.3, 1.5), qwenTier(null, 6.0, 60.0)] },
};

// Q0c/MJ2 — the loud fallback for an UNKNOWN model: a known-zero price, NOT the
// Opus default. A non-Claude / unpriced model billed at Opus rates is a silent
// ~10× overbill; charging $0 + warning (see priceForModel) makes it observable.
export const UNKNOWN_MODEL_PRICE: ModelPrice = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };

// A sync model→price resolver backed by the auto-pricing catalog (per-MILLION).
// Returns null when the model is unknown to the catalog.
export type CatalogLookup = (model: string) => ModelPrice | null;

// Resolve a model name to its ModelPrice. A null/undefined model is the default
// Claude (→ opus); Claude family names substring-match. config.prices is a manual
// OVERRIDE (present → wins); when absent, the auto-pricing catalog (current
// cross-provider prices) is consulted before the loud known-zero fallback. Only a
// model unknown to BOTH falls back to UNKNOWN_MODEL_PRICE and invokes onUnknown so
// the caller can warn once — never the silent Opus default (MJ2/Q0c).
export function priceForModel(
  prices: Record<string, ModelPriceSpec>,
  model: string | null | undefined,
  onUnknown?: (model: string) => void,
  catalogLookup?: CatalogLookup,
): ModelPriceSpec {
  const m = String(model ?? "opus").toLowerCase();
  if (m in prices) return prices[m];
  if (m.includes("fable")) return prices.fable;
  if (m.includes("opus")) return prices.opus;
  if (m.includes("sonnet")) return prices.sonnet;
  if (m.includes("haiku")) return prices.haiku;
  const fromCatalog = catalogLookup?.(m);
  if (fromCatalog) return fromCatalog;
  onUnknown?.(m);
  return UNKNOWN_MODEL_PRICE;
}

// MJ2 — a costMode:"billed" profile bills at the loud known-zero when no price is
// resolvable. True ⇒ this billed profile has no price in config.prices NOR the
// pricing catalog for its model/pricing key. Pure: used at config-load (warn) and
// at POST /api/backends (warn, never reject — the catalog auto-resolves most).
export function billedProfileNeedsPrice(
  profile: BackendProfile,
  prices: Record<string, ModelPriceSpec>,
  catalogLookup?: CatalogLookup,
): boolean {
  if (profile.costMode !== "billed") return false;
  let known = true;
  priceForModel(prices, profile.pricing ?? profile.model, () => { known = false; }, catalogLookup);
  return !known;
}

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
      defaultStepTimeoutMs: 900000, // 15 min hang backstop (mandatory fail-closed; must be > 0)
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

// A flat price override: any subset of the 5 rate fields (partial) so a config
// like `{ sonnet: { in: 4 } }` keeps the other rates (mergeConfig field-merges).
// .strict() so a MALFORMED tiered entry (e.g. a tier missing in/out) can't slip
// through this branch by having its `tiers` key stripped to an empty `{}` —
// which would silently become a $0 flat price. Strict makes it fail both union
// branches → the whole override is loudly dropped instead of mispricing.
const FlatModelPriceOverrideSchema = z.object({
  in: z.number().nonnegative(),
  out: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheCreate: z.number().nonnegative(),
  cacheCreate1h: z.number().nonnegative(),
}).partial().strict();

// One context-threshold tier: in/out are required (a tier must define complete
// rates or tier selection yields NaN); cache rates default to 0.
const PriceTierSchema = z.object({
  maxInputTokens: z.number().int().nonnegative().nullable(),
  price: z.object({
    in: z.number().nonnegative(),
    out: z.number().nonnegative(),
    cacheRead: z.number().nonnegative().default(0),
    cacheCreate: z.number().nonnegative().default(0),
    cacheCreate1h: z.number().nonnegative().default(0),
  }),
});

const TieredModelPriceSchema = z.object({
  tiers: z.array(PriceTierSchema).min(1),
});

// Accepts BOTH forms. Tiered MUST be tried first: a flat `.partial()` object
// would also accept `{ tiers: [...] }` (stripping the unknown key to `{}`), so
// ordering tiered first is what disambiguates a tiered entry from a flat one.
const ModelPriceOverrideSchema = z.union([TieredModelPriceSchema, FlatModelPriceOverrideSchema]);

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
    // > 0, not nonnegative: the per-step hang backstop is the fail-closed
    // guarantee. 0 would let a node that never emits its output hang the run
    // forever, so a config setting it to 0 is rejected and the safe default holds.
    defaultStepTimeoutMs: z.number().int().positive(),
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
// (model → flat {in,out,cacheRead,cacheCreate,cacheCreate1h} OR a tiered spec).
// A flat partial override like `{ sonnet: { in: 4 } }` must preserve the other 4
// fields instead of wiping them — otherwise computeCostUsd produces NaN. A
// tiered override replaces wholesale: field-merging it into a flat base (or vice
// versa) would corrupt the tiers array.
function mergeConfig(base: DaemonConfig, override: unknown): DaemonConfig {
  if (!override || typeof override !== "object") return base;
  const out: DaemonConfig = JSON.parse(JSON.stringify(base));
  const o = override as Record<string, unknown>;
  for (const k of Object.keys(out) as Array<keyof DaemonConfig>) {
    const incoming = o[k];
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) continue;
    if (k === "prices") {
      const incPrices = incoming as Record<string, ModelPriceSpec | Partial<ModelPrice>>;
      for (const model of Object.keys(incPrices)) {
        const inc = incPrices[model];
        // Tiered override → replace wholesale (a fresh clone, isolated from `o`).
        if (isTieredPrice(inc as ModelPriceSpec)) {
          out.prices[model] = JSON.parse(JSON.stringify(inc));
          continue;
        }
        // Flat override → field-merge over a flat base (or zero-base when the
        // base is absent or tiered) so a partial keeps the untouched rate fields.
        const base = out.prices[model];
        const flatBase = base && !isTieredPrice(base)
          ? (base as ModelPrice)
          : { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0 };
        out.prices[model] = { ...flatBase, ...(inc as Partial<ModelPrice>) };
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
  // MJ2 — warn (never block startup) on a billed profile with no MANUAL price, so an
  // unpriced metered lane is observable at load. The auto-pricing catalog (loaded
  // async in the daemon) is not available here, so this checks config.prices only;
  // the catalog still backstops the price at runtime (priceFor). Add config.prices
  // to override the catalog.
  for (const [name, profile] of Object.entries(cached.backends)) {
    if (billedProfileNeedsPrice(profile, cached.prices)) {
      console.log(`[config] backend "${name}" is costMode:"billed" with no price in config.prices for model "${profile.model}" — the pricing catalog is consulted at runtime; add config.prices to override`);
    }
  }
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
