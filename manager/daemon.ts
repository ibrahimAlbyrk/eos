#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { parse as parseYaml } from "yaml";
import { loadConfig, type ModelPrice } from "./shared/config.ts";
import { createLogger } from "./shared/logger.ts";

const log = createLogger("daemon");

const CONFIG = loadConfig();
const PORT = CONFIG.daemon.port;
const HOST = CONFIG.daemon.host;
const DAEMON_DIR = CONFIG.daemon.home;
const LOG_DIR = CONFIG.daemon.logDir;
const PID_FILE = CONFIG.daemon.pidFile;
const REPO_ROOT = CONFIG.paths.repoRoot;
const WORKER_SCRIPT = CONFIG.paths.workerScript;

try { writeFileSync(PID_FILE, String(process.pid)); } catch {}

// One-shot backup of the existing state.db before opening it. Keeps the last
// 5 snapshots in ~/.claude-mgr/backups/. Skipped if the DB doesn't exist yet
// (first run) or copy fails (transient FS issues — shouldn't block startup).
function backupDbOnStartup(): void {
  if (!existsSync(CONFIG.daemon.dbFile)) return;
  try {
    const backupDir = join(CONFIG.daemon.home, "backups");
    mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dst = join(backupDir, `state.db.${stamp}.bak`);
    copyFileSync(CONFIG.daemon.dbFile, dst);
    // Trim — keep the 5 newest *.bak files.
    const all = readdirSync(backupDir)
      .filter((n) => n.startsWith("state.db.") && n.endsWith(".bak"))
      .map((n) => ({ n, t: statSync(join(backupDir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of all.slice(5)) {
      try { unlinkSync(join(backupDir, old.n)); } catch {}
    }
  } catch (e) {
    // Backup is best-effort. Surface on stderr; daemon still boots.
    process.stderr.write(`[daemon] backup skipped: ${(e as Error).message}\n`);
  }
}
backupDbOnStartup();

const db = new DatabaseSync(CONFIG.daemon.dbFile);
db.exec("PRAGMA journal_mode = WAL");

// Versioned migrations. Each entry is applied once, in order. Adding a new
// schema change means appending an entry — never mutate or reorder existing
// ones. `schema_migrations.id` records what's been run.
//
// SQLite's ALTER TABLE doesn't support IF NOT EXISTS for columns, so the
// migration runner wraps each step in a savepoint and skips it if already
// recorded. ADD COLUMN on an existing column does throw, but we never reach
// that branch because the version check prevents reruns.
const MIGRATIONS: Array<{ id: string; sql: string }> = [
  { id: "001_init_workers", sql: `
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      cwd TEXT,
      worktree_from TEXT,
      branch TEXT,
      prompt TEXT NOT NULL,
      name TEXT,
      pid INTEGER,
      port INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER
    )
  `},
  { id: "002_workers_add_parent_id", sql: "ALTER TABLE workers ADD COLUMN parent_id TEXT" },
  { id: "003_workers_add_model", sql: "ALTER TABLE workers ADD COLUMN model TEXT" },
  { id: "004_workers_add_tokens_in", sql: "ALTER TABLE workers ADD COLUMN tokens_in INTEGER DEFAULT 0" },
  { id: "005_workers_add_tokens_out", sql: "ALTER TABLE workers ADD COLUMN tokens_out INTEGER DEFAULT 0" },
  { id: "006_workers_add_tokens_cache_read", sql: "ALTER TABLE workers ADD COLUMN tokens_cache_read INTEGER DEFAULT 0" },
  { id: "007_workers_add_tokens_cache_create", sql: "ALTER TABLE workers ADD COLUMN tokens_cache_create INTEGER DEFAULT 0" },
  { id: "008_workers_add_cost_usd", sql: "ALTER TABLE workers ADD COLUMN cost_usd REAL DEFAULT 0" },
  { id: "009_init_events", sql: `
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT
    )
  `},
  { id: "010_idx_events_worker_ts", sql: "CREATE INDEX IF NOT EXISTS idx_events_worker_ts ON events(worker_id, ts)" },
  { id: "011_init_pending_permissions", sql: `
    CREATE TABLE IF NOT EXISTS pending_permissions (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      tool_use_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      decision TEXT,
      reason TEXT,
      updated_input TEXT
    )
  `},
  { id: "012_idx_pending_unresolved", sql: "CREATE INDEX IF NOT EXISTS idx_pending_unresolved ON pending_permissions(resolved, expires_at)" },
];

db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
{
  const applied = new Set<string>();
  for (const row of db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>) {
    applied.add(row.id);
  }
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  let ranCount = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    try {
      db.exec(m.sql);
      insert.run(m.id, Date.now());
      ranCount++;
    } catch (e) {
      // Pre-versioning DBs may already have these columns/indices applied
      // by the old try/catch ALTERs. Treat any failure as "already there"
      // and just record the migration so we skip it next boot.
      const msg = (e as Error).message;
      if (/duplicate column|already exists/i.test(msg)) {
        insert.run(m.id, Date.now());
      } else {
        console.log(`[daemon] migration ${m.id} failed: ${msg}`);
        throw e;
      }
    }
  }
  if (ranCount > 0) console.log(`[daemon] applied ${ranCount} migration(s)`);
}

// Periodic VACUUM. SQLite never shrinks pages after a DELETE wave (worker
// terminations, manual kills) — VACUUM rebuilds the file and reclaims space.
// We track the last run in schema_migrations under a reserved id so the
// schedule survives restarts.
const VACUUM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const VACUUM_MARKER = "__vacuum_last_run";

function maybeVacuum(reason: string): void {
  // Skip if any worker is still in a non-terminal state — VACUUM acquires a
  // write lock and we don't want to stall a long-running query.
  const busy = db.prepare(
    "SELECT COUNT(*) AS n FROM workers WHERE state NOT IN ('DONE','KILLING')"
  ).get() as { n: number } | undefined;
  if (busy && busy.n > 0) return;

  const last = db.prepare("SELECT applied_at FROM schema_migrations WHERE id = ?").get(VACUUM_MARKER) as { applied_at: number } | undefined;
  const now = Date.now();
  if (last && now - last.applied_at < VACUUM_INTERVAL_MS) return;

  try {
    const before = Date.now();
    db.exec("VACUUM");
    const ms = Date.now() - before;
    if (last) db.prepare("UPDATE schema_migrations SET applied_at = ? WHERE id = ?").run(now, VACUUM_MARKER);
    else db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(VACUUM_MARKER, now);
    console.log(`[daemon] VACUUM ok (${ms}ms, reason=${reason})`);
  } catch (e) {
    console.log(`[daemon] VACUUM failed: ${(e as Error).message}`);
  }
}

// Run once at startup, then every hour the daemon stays up. Both gated by the
// 7-day interval check above so it's effectively rate-limited to weekly.
maybeVacuum("startup");
setInterval(() => maybeVacuum("scheduled"), 60 * 60 * 1000);

// Stale-pending sweep — daemon may have died while requests were waiting; on
// restart, anything past its TTL becomes a deterministic deny so the worker
// (if it ever reconnects) gets a clean answer instead of a stuck spinner.
{
  const now = Date.now();
  const stale = db.prepare(
    "SELECT id FROM pending_permissions WHERE resolved = 0 AND expires_at < ?"
  ).all(now) as Array<{ id: string }>;
  if (stale.length > 0) {
    const stmt = db.prepare(
      "UPDATE pending_permissions SET resolved = 1, decision = 'deny', reason = 'daemon restart sweep' WHERE id = ?"
    );
    for (const r of stale) stmt.run(r.id);
    log.info("swept stale pending permissions", { count: stale.length });
  }
}

// Orphan worktree scan — log-only, never deletes (worktree contents could be
// uncommitted user work). Compares DB-tracked worktree paths to filesystem
// reality. Mismatches surface as warnings so the operator can investigate.
{
  const rows = db.prepare(
    "SELECT id, worktree_from, branch FROM workers WHERE worktree_from IS NOT NULL"
  ).all() as Array<{ id: string; worktree_from: string; branch: string | null }>;
  for (const r of rows) {
    if (!r.worktree_from || !existsSync(r.worktree_from)) {
      log.warn("worker references missing worktree path", { worker: r.id, path: r.worktree_from, branch: r.branch });
    }
  }
}

// Per-million-token pricing in USD. Defaults mirror public Anthropic API rates;
// override via ~/.claude-mgr/config.json under `prices` if Anthropic changes them.
const MODEL_PRICES = CONFIG.prices;
function priceFor(model: string | null | undefined): ModelPrice {
  const m = String(model ?? "opus").toLowerCase();
  if (m.includes("opus")) return MODEL_PRICES.opus;
  if (m.includes("sonnet")) return MODEL_PRICES.sonnet;
  if (m.includes("haiku")) return MODEL_PRICES.haiku;
  return MODEL_PRICES.opus;
}
function computeCostUsd(model: string | null | undefined, tIn: number, tOut: number, cRead: number, cCreate: number): number {
  const p = priceFor(model);
  return (tIn * p.in + tOut * p.out + cRead * p.cacheRead + cCreate * p.cacheCreate) / 1_000_000;
}

// Policy engine itself lives in shared/policy.ts so it can be unit-tested
// without booting the HTTP server / DB. Daemon owns loading + I/O.
import { compileRule, evaluatePolicy as evaluatePolicyPure, type Policy, type PolicyRule, type CompiledRule, type Decision } from "./shared/policy.ts";

function loadPolicy(): Policy {
  const candidates = [
    join(DAEMON_DIR, "policy.yaml"),
    join(REPO_ROOT, "manager", "policy.example.yaml"),
  ];
  const log = (m: string) => console.log(`[daemon] ${m}`);
  for (const p of candidates) {
    if (existsSync(p)) {
      const parsed = parseYaml(readFileSync(p, "utf8"));
      const rawRules: PolicyRule[] = parsed.rules ?? [];
      const compiled: CompiledRule[] = [];
      for (let i = 0; i < rawRules.length; i++) {
        const c = compileRule(rawRules[i], i, p, log);
        if (c) compiled.push(c);
      }
      console.log(`[daemon] policy loaded from ${p} (${compiled.length}/${rawRules.length} rules)`);
      return {
        default: parsed.default ?? "ask",
        ttlMs: parsed.ttlMs ?? CONFIG.permissions.defaultTtlMs,
        rules: compiled,
      };
    }
  }
  console.log("[daemon] no policy file found; default=ask, no rules");
  return { default: "ask", ttlMs: CONFIG.permissions.defaultTtlMs, rules: [] };
}
let policy = loadPolicy();

function evaluatePolicy(toolName: string, input: Record<string, unknown>): Decision {
  return evaluatePolicyPure(policy, toolName, input);
}

const pendingResolvers = new Map<string, (d: Decision) => void>();

function newPendingId(): string {
  return "p-" + Math.random().toString(36).slice(2, 10);
}

async function decide(workerId: string, toolName: string, input: Record<string, unknown>, toolUseId: string | undefined): Promise<Decision> {
  let decision = evaluatePolicy(toolName, input);
  logEvent(workerId, "policy", { tool: toolName, decision: decision.behavior });
  // Bookkeeping for /metrics — sampled after rule evaluation, before any ask
  // resolves, so rewrite-then-allow still counts as a single "allow".
  if (decision.behavior === "allow") metrics.policyAllow++;
  else if (decision.behavior === "deny") metrics.policyDeny++;
  else metrics.policyAsk++;

  if (decision.behavior !== "ask") return decision;

  const id = newPendingId();
  const now = Date.now();
  const expiresAt = now + policy.ttlMs;
  db.prepare(`
    INSERT INTO pending_permissions (id, worker_id, tool_name, input, tool_use_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, workerId, toolName, JSON.stringify(input), toolUseId ?? null, now, expiresAt);
  logEvent(workerId, "permission_pending", { id, tool: toolName });

  return new Promise<Decision>((resolve) => {
    pendingResolvers.set(id, resolve);
    setTimeout(() => {
      if (!pendingResolvers.has(id)) return;
      pendingResolvers.delete(id);
      db.prepare("UPDATE pending_permissions SET resolved=1, decision=?, reason=? WHERE id=?")
        .run("deny", "TTL exceeded", id);
      logEvent(workerId, "permission_ttl_deny", { id });
      resolve({ behavior: "deny", message: "human approval timed out" });
    }, policy.ttlMs);
  });
}

function resolvePending(id: string, decision: Decision): boolean {
  // Always mark the DB row resolved so the UI's view stays consistent.
  // The in-memory resolver may be missing if the daemon was restarted while a
  // pending was in flight, or for synthetic rows from tooling — that's fine.
  const updatedInput = decision.behavior === "allow" ? JSON.stringify(decision.updatedInput) : null;
  const reason = decision.behavior === "deny" ? decision.message : null;
  const info = db.prepare("UPDATE pending_permissions SET resolved=1, decision=?, reason=?, updated_input=? WHERE id=? AND resolved=0")
    .run(decision.behavior, reason, updatedInput, id);
  const resolver = pendingResolvers.get(id);
  if (resolver) {
    pendingResolvers.delete(id);
    resolver(decision);
  }
  // changes() returns 0 if the row was already resolved or doesn't exist.
  return Number(info.changes) > 0;
}

type Row = Record<string, unknown>;
const children = new Map<string, ChildProcess>();
const usedPorts = new Set<number>();
const sseClients = new Set<ServerResponse>();

// Process-lifetime counters for /metrics. Reset only on daemon restart.
const startedAtMs = Date.now();
const metrics = {
  policyAllow: 0,
  policyDeny: 0,
  policyAsk: 0,
  policyRewrite: 0,
  requests: 0,
  bodyTooLarge: 0,
};

function broadcast(reason: string = "tick"): void {
  if (sseClients.size === 0) return;
  const msg = `event: change\ndata: ${JSON.stringify({ reason, ts: Date.now() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

function newId(): string {
  return "w-" + Math.random().toString(36).slice(2, 10);
}

async function findFreePort(start = CONFIG.worker.portRangeStart): Promise<number> {
  for (let p = start; p <= CONFIG.worker.portRangeEnd; p++) {
    if (usedPorts.has(p)) continue;
    // Reserve BEFORE the async bind test so two concurrent callers can't both
    // see the same port as free, race on the socket probe, and both claim it.
    // If the probe finds the port actually busy, release the reservation.
    usedPorts.add(p);
    const free = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port: p, host: HOST, timeout: 50 });
      sock.once("connect", () => { sock.destroy(); resolve(false); });
      sock.once("error", () => resolve(true));
      sock.once("timeout", () => { sock.destroy(); resolve(true); });
    });
    if (free) return p;
    usedPorts.delete(p);
  }
  throw new Error(`no free port in range ${CONFIG.worker.portRangeStart}-${CONFIG.worker.portRangeEnd}`);
}

function logEvent(workerId: string, type: string, payload?: unknown): void {
  db.prepare("INSERT INTO events (worker_id, ts, type, payload) VALUES (?, ?, ?, ?)")
    .run(workerId, Date.now(), type, payload === undefined ? null : JSON.stringify(payload));
  broadcast(`event:${type}:${workerId}`);
}

import { canTransition, type WorkerState } from "./shared/state-machine.ts";

function transitionState(workerId: string, next: WorkerState, reason: string): void {
  const cur = db.prepare("SELECT state FROM workers WHERE id = ?").get(workerId) as Row | undefined;
  if (!cur) return;
  const from = (cur.state as string).toUpperCase() as WorkerState;
  if (from === next) return; // suppress redundant transitions

  if (!canTransition(from, next)) {
    // Soft-reject: log but don't throw. The orchestrator is single-process so
    // these races are rare; surfacing them in events helps debug without
    // wedging the daemon.
    logEvent(workerId, "state_reject", { from, to: next, reason });
    return;
  }
  db.prepare("UPDATE workers SET state = ? WHERE id = ?").run(next, workerId);
  logEvent(workerId, "state", { state: next, from, reason });
}

// Legacy alias — call sites pre-dating transitionState() pass no reason.
// New code should call transitionState() directly with a reason string.
function setState(workerId: string, state: string): void {
  transitionState(workerId, state.toUpperCase() as WorkerState, "legacy");
}

interface SpawnOpts {
  prompt: string;
  cwd?: string;
  worktreeFrom?: string;
  branch?: string;
  name?: string;
  withGateway?: boolean;
  persistent?: boolean;
  systemPromptFile?: string;
  mcpConfig?: string;
  permissionPromptTool?: string;
  claudePermissionMode?: string;
  fixedId?: string;
  parentId?: string;
  model?: string;
  /** Hard ceiling in USD. When cur cost_usd exceeds this, daemon SIGTERMs the
   *  worker and logs a `limit_exceeded` event with kind="cost". Undefined = no cap. */
  maxCostUsd?: number;
  /** Hard ceiling in milliseconds since started_at. Periodically checked
   *  against Date.now() - started_at. Undefined = no cap. */
  maxElapsedMs?: number;
}

// Per-worker limit cache — kept in memory alongside the DB row so the periodic
// guard sweep doesn't have to re-read SpawnOpts. Cleared on worker DELETE.
const workerLimits = new Map<string, { maxCostUsd?: number; maxElapsedMs?: number }>();

// Probes the current worker row against its cached limits. Fires SIGTERM and
// emits a `limit_exceeded` event the first time a cap is crossed; the worker
// then transitions to KILLING via the standard exit path. Cheap: returns
// immediately if no limits are configured.
function checkWorkerLimits(workerId: string): void {
  const limits = workerLimits.get(workerId);
  if (!limits) return;
  const row = db.prepare("SELECT state, started_at, cost_usd FROM workers WHERE id = ?").get(workerId) as Row | undefined;
  if (!row || row.state === "DONE" || row.state === "KILLING") return;

  let exceeded: { kind: "cost" | "elapsed"; value: number; limit: number } | null = null;
  if (limits.maxCostUsd != null && (row.cost_usd as number ?? 0) > limits.maxCostUsd) {
    exceeded = { kind: "cost", value: row.cost_usd as number, limit: limits.maxCostUsd };
  } else if (limits.maxElapsedMs != null) {
    const elapsed = Date.now() - (row.started_at as number);
    if (elapsed > limits.maxElapsedMs) {
      exceeded = { kind: "elapsed", value: elapsed, limit: limits.maxElapsedMs };
    }
  }
  if (!exceeded) return;

  logEvent(workerId, "limit_exceeded", exceeded);
  log.warn("worker over limit, killing", { worker: workerId, ...exceeded });
  transitionState(workerId, "KILLING", `limit_exceeded:${exceeded.kind}`);
  workerLimits.delete(workerId); // arm only once per worker
  const child = children.get(workerId);
  if (child) {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
  }
}

// Periodic sweep — handles maxElapsedMs (which doesn't piggyback off a usage
// event). 30s cadence is loose enough to be cheap, tight enough that an
// overshoot of a few seconds is acceptable.
setInterval(() => {
  for (const id of workerLimits.keys()) checkWorkerLimits(id);
}, 30_000);

function expandPath(p: string | undefined): string | undefined {
  if (!p) return p;
  let out = p.trim();
  if (out.startsWith("~")) {
    const home = process.env.HOME || homedir();
    out = out === "~" || out.startsWith("~/") ? home + out.slice(1) : out;
  }
  return out;
}

async function spawnWorker(opts: SpawnOpts): Promise<{ id: string; port: number }> {
  const id = opts.fixedId ?? newId();
  const port = await findFreePort();

  // Normalize paths — orchestrator/LLM may pass "~" or omit cwd entirely.
  opts.cwd = expandPath(opts.cwd);
  opts.worktreeFrom = expandPath(opts.worktreeFrom);
  if (!opts.cwd && !opts.worktreeFrom) {
    opts.cwd = process.env.HOME || homedir();
    logEvent(id, "warning", { text: `no cwd given; defaulted to ${opts.cwd}` });
  }

  const args = [
    "--experimental-strip-types",
    "--no-warnings",
    WORKER_SCRIPT,
    "--daemon-url", `http://127.0.0.1:${PORT}`,
    "--worker-id", id,
    "--port", String(port),
    "--prompt", opts.prompt,
  ];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.worktreeFrom) args.push("--worktree-from", opts.worktreeFrom);
  if (opts.branch) args.push("--branch", opts.branch);
  if (opts.name) args.push("--name", opts.name);
  if (opts.withGateway) args.push("--with-gateway");
  if (opts.persistent) args.push("--persistent");
  if (opts.systemPromptFile) args.push("--system-prompt-file", opts.systemPromptFile);
  if (opts.mcpConfig) args.push("--mcp-config", opts.mcpConfig);
  if (opts.permissionPromptTool) args.push("--permission-prompt-tool", opts.permissionPromptTool);
  if (opts.claudePermissionMode) args.push("--claude-permission-mode", opts.claudePermissionMode);
  const model = opts.model ?? "opus";
  args.push("--model", model);

  const logPath = join(LOG_DIR, `${id}.log`);
  const out = createWriteStream(logPath);

  // Pass binary paths + repo root via env so worker.ts doesn't need to import
  // the config module across the spawner/manager package boundary.
  const child = spawn("node", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: {
      ...process.env,
      CLAUDE_MGR_CLAUDE_BIN: CONFIG.paths.claudeBin,
      CLAUDE_MGR_BUN_BIN: CONFIG.paths.bunBin,
      CLAUDE_MGR_REPO_ROOT: REPO_ROOT,
      CLAUDE_MGR_GATEWAY_SCRIPT: join(REPO_ROOT, "gateway", "server.ts"),
    },
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);

  children.set(id, child);
  if (opts.maxCostUsd != null || opts.maxElapsedMs != null) {
    workerLimits.set(id, { maxCostUsd: opts.maxCostUsd, maxElapsedMs: opts.maxElapsedMs });
  }

  db.prepare(`
    INSERT INTO workers (id, state, cwd, worktree_from, branch, prompt, name, pid, port, started_at, parent_id, model)
    VALUES (?, 'SPAWNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.cwd ?? null,
    opts.worktreeFrom ?? null,
    opts.branch ?? null,
    opts.prompt,
    opts.name ?? null,
    child.pid ?? null,
    port,
    Date.now(),
    opts.parentId ?? null,
    model,
  );
  logEvent(id, "spawn", { args: args.slice(2), pid: child.pid });

  child.on("exit", (code) => {
    db.prepare("UPDATE workers SET state = 'DONE', ended_at = ?, exit_code = ? WHERE id = ?")
      .run(Date.now(), code, id);
    logEvent(id, "exit", { code });
    children.delete(id);
    workerLimits.delete(id);
    usedPorts.delete(port);
    // Flush any pending stdout/stderr lines before the log handle is GC'd.
    // SIGKILL'd children sometimes leave the pipe with buffered bytes.
    try { out.end(); } catch {}
    broadcast("worker:exit");
  });

  broadcast("worker:spawn");

  return { id, port };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// 1 MB hard cap on request bodies. Daemon is localhost-only, but a buggy
// client (or future hostile MCP server) could otherwise pour unlimited bytes
// into memory. Rejecting early also kills the chunk pipe so we don't keep
// buffering after the limit is hit.
const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() { super("request body too large"); this.name = "BodyTooLargeError"; }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer | string) => {
      if (aborted) return;
      size += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        try { req.destroy(); } catch {}
        reject(new BodyTooLargeError());
        return;
      }
      raw += c;
    });
    req.on("end", () => {
      if (aborted) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const m = req.method ?? "GET";
  const p = url.pathname;
  metrics.requests++;

  // Request id — accept incoming X-Request-Id if a caller already minted one,
  // otherwise mint our own. Echo on the response so a curl/UI client can
  // correlate with daemon logs.
  const requestId = String(req.headers["x-request-id"] || `r-${Math.random().toString(36).slice(2, 10)}`);
  res.setHeader("x-request-id", requestId);

  try {
    if (m === "GET" && p === "/health") return json(res, 200, { ok: true });

    // Prometheus text exposition format. Scrapeable by node_exporter-style
    // tools or just curl. No labels-by-worker — events table holds that
    // detail; this endpoint is for daemon-process-level signals.
    if (m === "GET" && p === "/metrics") {
      const stateRows = db.prepare("SELECT state, COUNT(*) AS n FROM workers GROUP BY state").all() as Array<{ state: string; n: number }>;
      const pendingCount = (db.prepare("SELECT COUNT(*) AS n FROM pending_permissions WHERE resolved = 0").get() as { n: number } | undefined)?.n ?? 0;
      const uptimeSec = Math.floor((Date.now() - startedAtMs) / 1000);
      const lines: string[] = [
        "# HELP claude_mgr_uptime_seconds Daemon uptime",
        "# TYPE claude_mgr_uptime_seconds gauge",
        `claude_mgr_uptime_seconds ${uptimeSec}`,
        "# HELP claude_mgr_workers Worker count by state",
        "# TYPE claude_mgr_workers gauge",
      ];
      for (const r of stateRows) lines.push(`claude_mgr_workers{state="${r.state}"} ${r.n}`);
      lines.push(
        "# HELP claude_mgr_sse_clients Active SSE subscribers",
        "# TYPE claude_mgr_sse_clients gauge",
        `claude_mgr_sse_clients ${sseClients.size}`,
        "# HELP claude_mgr_pending Pending permission requests",
        "# TYPE claude_mgr_pending gauge",
        `claude_mgr_pending ${pendingCount}`,
        "# HELP claude_mgr_policy_decisions_total Cumulative policy decisions",
        "# TYPE claude_mgr_policy_decisions_total counter",
        `claude_mgr_policy_decisions_total{behavior="allow"} ${metrics.policyAllow}`,
        `claude_mgr_policy_decisions_total{behavior="deny"} ${metrics.policyDeny}`,
        `claude_mgr_policy_decisions_total{behavior="ask"} ${metrics.policyAsk}`,
        "# HELP claude_mgr_requests_total HTTP requests served",
        "# TYPE claude_mgr_requests_total counter",
        `claude_mgr_requests_total ${metrics.requests}`,
        "# HELP claude_mgr_body_too_large_total Requests rejected for body-size limit",
        "# TYPE claude_mgr_body_too_large_total counter",
        `claude_mgr_body_too_large_total ${metrics.bodyTooLarge}`,
      );
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(lines.join("\n") + "\n");
      return;
    }

    // UI-config: exposes the subset of daemon config the web UI cares about.
    // Frontend src/config.js hydrates its defaults from this on startup so
    // sysadmins can tune polling/debounce/budgets/models via config.json
    // without rebuilding the web bundle.
    if (m === "GET" && p === "/api/ui-config") {
      return json(res, 200, {
        models: Object.keys(CONFIG.prices),
        budgets: {
          opus: 1_000_000,
          sonnet: 1_000_000,
          haiku: 200_000,
          default: 200_000,
        },
        prices: CONFIG.prices,
        permissions: { defaultTtlMs: CONFIG.permissions.defaultTtlMs },
        sse: { keepaliveMs: CONFIG.daemon.sseKeepaliveMs },
      });
    }

    // Server-Sent Events stream for live updates
    if (m === "GET" && p === "/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write("retry: 2000\n\n");
      res.write(":connected\n\n");
      sseClients.add(res);
      const ka = setInterval(() => {
        try { res.write(":ka\n\n"); } catch { clearInterval(ka); sseClients.delete(res); }
      }, CONFIG.daemon.sseKeepaliveMs);
      req.on("close", () => { sseClients.delete(res); clearInterval(ka); });
      return;
    }

    // Static web UI under /web/* — served from manager/web/dist (Vite build output).
    // Run `npm run build` in manager/web to produce dist/.
    if (m === "GET" && (p === "/web" || p === "/web/" || p.startsWith("/web/"))) {
      let rel = p === "/web" || p === "/web/" ? "/index.html" : p.slice(4);
      const webRoot = join(REPO_ROOT, "manager", "web", "dist");
      const full = join(webRoot, rel);
      if (!full.startsWith(webRoot) || !existsSync(full)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found — run `npm run build` in manager/web");
        return;
      }
      const ext = rel.split(".").pop() || "";
      const mime =
        ext === "html" ? "text/html; charset=utf-8" :
        ext === "css"  ? "text/css; charset=utf-8" :
        ext === "js"   ? "text/javascript; charset=utf-8" :
        ext === "mjs"  ? "text/javascript; charset=utf-8" :
        ext === "json" ? "application/json; charset=utf-8" :
        ext === "svg"  ? "image/svg+xml" :
        ext === "map"  ? "application/json; charset=utf-8" :
        ext === "woff2" ? "font/woff2" :
        ext === "woff" ? "font/woff" :
        "application/octet-stream";
      // Hashed asset filenames are stable — let the browser cache them. Only
      // index.html stays no-store so the entrypoint always picks up new builds.
      const cache = ext === "html" ? "no-store" : "public, max-age=31536000, immutable";
      res.writeHead(200, { "content-type": mime, "cache-control": cache });
      res.end(readFileSync(full));
      return;
    }
    if (m === "GET" && p === "/") {
      res.writeHead(302, { location: "/web/" });
      res.end();
      return;
    }

    if (m === "GET" && p === "/workers") {
      const rows = db.prepare("SELECT * FROM workers ORDER BY started_at DESC").all() as Row[];
      return json(res, 200, rows);
    }

    if (m === "POST" && p === "/workers") {
      const body = (await readBody(req)) as Partial<SpawnOpts>;
      if (!body.prompt) return json(res, 400, { error: "prompt required" });
      const result = await spawnWorker(body as SpawnOpts);
      return json(res, 201, result);
    }

    const detailMatch = p.match(/^\/workers\/([^/]+)$/);
    if (detailMatch) {
      const id = detailMatch[1];
      if (m === "GET") {
        const row = db.prepare("SELECT * FROM workers WHERE id = ?").get(id);
        if (!row) return json(res, 404, { error: "not found" });
        return json(res, 200, row);
      }
      if (m === "DELETE") {
        const w = db.prepare("SELECT pid, name, state FROM workers WHERE id = ?").get(id) as Row | undefined;
        if (!w) return json(res, 404, { error: "worker not found" });

        const child = children.get(id);
        const killed: { pid: number; via: string }[] = [];
        const seen = new Set<number>();

        const tryKill = (pid: number | undefined, via: string) => {
          if (!pid || pid <= 0 || pid === process.pid || seen.has(pid)) return;
          try { process.kill(pid, "SIGTERM"); killed.push({ pid, via }); seen.add(pid); } catch {}
        };

        if (child) {
          try { child.kill("SIGTERM"); killed.push({ pid: child.pid ?? 0, via: "tracked-child" }); seen.add(child.pid ?? 0); } catch {}
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
        }
        tryKill(Number(w.pid), "stored-pid");
        try {
          // execFile avoids the shell — w.name can contain quotes/semicolons.
          // pgrep itself treats the pattern as a regex; we anchor with the
          // literal `cm-` prefix and quote-escape the name's regex metachars.
          const safeName = String(w.name || id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const pattern = `cm-${safeName}-`;
          const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
          out.split(/\s+/).map(Number).filter(Boolean).forEach((p) => tryKill(p, "pgrep"));
        } catch {}

        // SIGKILL escalation 2s after SIGTERM — claude PTY children sometimes
        // ignore/delay SIGTERM, so we hammer them.
        setTimeout(() => {
          for (const k of killed) {
            try { process.kill(k.pid, "SIGKILL"); } catch {}
          }
        }, 2000);

        // Wipe everything tied to this worker: row, events, any pending permission rows.
        // The user expects a clean slate when an agent is killed (esp. orchestrator).
        children.delete(id);
        workerLimits.delete(id);
        db.prepare("DELETE FROM workers WHERE id = ?").run(id);
        db.prepare("DELETE FROM events WHERE worker_id = ?").run(id);
        db.prepare("DELETE FROM pending_permissions WHERE worker_id = ?").run(id);
        broadcast("worker:removed");
        return json(res, 200, { killed, removed: true, was_state: w.state });
      }
    }

    const eventsMatch = p.match(/^\/workers\/([^/]+)\/events$/);
    if (eventsMatch) {
      const id = eventsMatch[1];
      if (m === "GET") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 500), 5000);
        // Fetch the NEWEST N events (DESC + LIMIT), then re-sort ASC for chronological display.
        const rows = db.prepare(
          "SELECT * FROM (SELECT * FROM events WHERE worker_id = ? AND ts > ? ORDER BY ts DESC LIMIT ?) ORDER BY ts ASC"
        ).all(id, since, limit) as Row[];
        return json(res, 200, rows);
      }
      if (m === "POST") {
        const body = (await readBody(req)) as { type?: string; payload?: unknown };
        if (!body.type) return json(res, 400, { error: "type required" });
        logEvent(id, body.type, body.payload);
        if (body.type === "state" && typeof body.payload === "object" && body.payload && "state" in (body.payload as object)) {
          const newState = (body.payload as Record<string, unknown>).state;
          if (typeof newState === "string") {
            transitionState(id, newState.toUpperCase() as WorkerState, "worker_pushed");
          }
        }
        if (body.type === "hook" && typeof body.payload === "object" && body.payload) {
          const evtName = (body.payload as Record<string, unknown>).event;
          if (evtName === "PostToolUse") setState(id, "WORKING");
          else if (evtName === "Stop") setState(id, "IDLE");
          else if (evtName === "SessionEnd") setState(id, "ENDING");
        }
        // Long-form turns that emit assistant_text/thinking BEFORE any tool
        // would otherwise stay stuck in SPAWNING until PostToolUse fires. Only
        // lift from SPAWNING here — IDLE bumps are unsafe because JSONL gets
        // committed ~100ms after the Stop hook, which would flicker the state
        // back to WORKING right after the turn ended. IDLE→WORKING is handled
        // by the user_message eager bump and by heartbeat (gated by worker.ts).
        if (body.type === "jsonl" && typeof body.payload === "object" && body.payload) {
          const kind = (body.payload as Record<string, unknown>).kind;
          if (kind === "assistant_text" || kind === "thinking" || kind === "tool_use") {
            const cur = db.prepare("SELECT state FROM workers WHERE id = ?").get(id) as Row | undefined;
            if (cur && cur.state === "SPAWNING") setState(id, "WORKING");
          }
        }
        if (body.type === "heartbeat") {
          const cur = db.prepare("SELECT state FROM workers WHERE id = ?").get(id) as Row | undefined;
          if (cur && (cur.state === "SPAWNING" || cur.state === "IDLE")) setState(id, "WORKING");
        }
        if (body.type === "usage" && typeof body.payload === "object" && body.payload) {
          const u = body.payload as { in?: number; out?: number; cacheRead?: number; cacheCreate?: number; model?: string };
          const tIn = u.in ?? 0;
          const tOut = u.out ?? 0;
          const cRead = u.cacheRead ?? 0;
          const cCreate = u.cacheCreate ?? 0;
          // Cumulative running totals on the worker row, plus a delta-cost computed
          // per usage event so cost-per-hour can be derived from the events table.
          const row = db.prepare("SELECT model FROM workers WHERE id = ?").get(id) as Row | undefined;
          const model = u.model ?? (row?.model as string | null) ?? "opus";
          const deltaCost = computeCostUsd(model, tIn, tOut, cRead, cCreate);
          db.prepare(`
            UPDATE workers SET
              tokens_in = COALESCE(tokens_in, 0) + ?,
              tokens_out = COALESCE(tokens_out, 0) + ?,
              tokens_cache_read = COALESCE(tokens_cache_read, 0) + ?,
              tokens_cache_create = COALESCE(tokens_cache_create, 0) + ?,
              cost_usd = COALESCE(cost_usd, 0) + ?
            WHERE id = ?
          `).run(tIn, tOut, cRead, cCreate, deltaCost, id);
          // Attach the deltaCost into the event payload we just logged, so the
          // cost-per-hour SQL can sum it directly without re-parsing model.
          db.prepare("UPDATE events SET payload = ? WHERE worker_id = ? AND ts = (SELECT MAX(ts) FROM events WHERE worker_id = ? AND type = 'usage')")
            .run(JSON.stringify({ ...u, deltaCost }), id, id);
          // Cost just changed — recheck before returning so a runaway turn
          // gets killed at the next usage report instead of waiting 30s for
          // the periodic sweep.
          checkWorkerLimits(id);
        }
        return json(res, 200, { ok: true });
      }
    }

    const messageMatch = p.match(/^\/workers\/([^/]+)\/message$/);
    if (m === "POST" && messageMatch) {
      const id = messageMatch[1];
      const w = db.prepare("SELECT port, state FROM workers WHERE id = ?").get(id) as Row | undefined;
      if (!w) return json(res, 404, { error: "worker not found" });
      const body = (await readBody(req)) as { text?: string };
      if (!body.text) return json(res, 400, { error: "text required" });
      try {
        const r = await fetch(`http://127.0.0.1:${w.port}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: body.text }),
        });
        const result = await r.json();
        logEvent(id, "user_message", { text: body.text.slice(0, 200) });
        // Eagerly mark a new turn as active — otherwise the worker can sit in
        // IDLE (from the prior Stop hook) until a tool fires, even though
        // claude is already processing.
        setState(id, "WORKING");
        return json(res, r.status, result);
      } catch (e) {
        return json(res, 502, { error: `worker unreachable: ${(e as Error).message}` });
      }
    }

    const ORCH_ID = "orchestrator";
    if (m === "POST" && p === "/orchestrator/start") {
      const existing = db.prepare("SELECT id, state FROM workers WHERE id = ?").get(ORCH_ID) as Row | undefined;
      if (existing && existing.state !== "DONE" && children.has(ORCH_ID)) {
        return json(res, 200, { id: ORCH_ID, already_running: true });
      }
      if (existing) db.prepare("DELETE FROM workers WHERE id = ?").run(ORCH_ID);
      const mcpPath = join(DAEMON_DIR, "orchestrator-mcp.json");
      writeFileSync(mcpPath, JSON.stringify({
        mcpServers: {
          orchestrator: {
            command: "node",
            args: ["--no-warnings", "--experimental-strip-types", join(REPO_ROOT, "manager", "orchestrator-mcp.ts")],
            env: { ...process.env, CLAUDE_MGR_DAEMON_URL: `http://127.0.0.1:${PORT}` },
          },
        },
      }));
      const result = await spawnWorker({
        prompt: "You are now active. Say 'orchestrator ready' and wait for the user's first message.",
        cwd: REPO_ROOT,
        name: "orchestrator",
        fixedId: ORCH_ID,
        persistent: true,
        systemPromptFile: join(REPO_ROOT, "manager", "orchestrator-prompt.md"),
        mcpConfig: mcpPath,
        claudePermissionMode: "bypassPermissions",
        model: "opus",
      });
      return json(res, 201, result);
    }

    if (m === "POST" && p === "/orchestrator/message") {
      let row = db.prepare("SELECT id, port FROM workers WHERE id = ?").get(ORCH_ID) as Row | undefined;
      if (!row || !children.has(ORCH_ID)) {
        const mcpPath = join(DAEMON_DIR, "orchestrator-mcp.json");
        writeFileSync(mcpPath, JSON.stringify({
          mcpServers: {
            orchestrator: {
              command: "node",
              args: ["--no-warnings", "--experimental-strip-types", join(REPO_ROOT, "manager", "orchestrator-mcp.ts")],
              env: { ...process.env, CLAUDE_MGR_DAEMON_URL: `http://127.0.0.1:${PORT}` },
            },
          },
        }));
        if (row) db.prepare("DELETE FROM workers WHERE id = ?").run(ORCH_ID);
        await spawnWorker({
          prompt: "Standing by. Wait for the user's first instruction.",
          cwd: REPO_ROOT,
          name: "orchestrator",
          fixedId: ORCH_ID,
          persistent: true,
          systemPromptFile: join(REPO_ROOT, "manager", "orchestrator-prompt.md"),
          mcpConfig: mcpPath,
          claudePermissionMode: "bypassPermissions",
          model: "opus",
        });
        await new Promise((r) => setTimeout(r, 6000));
        row = db.prepare("SELECT id, port FROM workers WHERE id = ?").get(ORCH_ID) as Row | undefined;
      }
      if (!row) return json(res, 500, { error: "failed to spawn orchestrator" });
      const body = (await readBody(req)) as { text?: string };
      if (!body.text) return json(res, 400, { error: "text required" });
      try {
        const r = await fetch(`http://127.0.0.1:${row.port}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: body.text }),
        });
        const result = await r.json();
        logEvent(ORCH_ID, "user_message", { text: body.text.slice(0, 500) });
        setState(ORCH_ID, "WORKING");
        return json(res, r.status, result);
      } catch (e) {
        return json(res, 502, { error: `orchestrator unreachable: ${(e as Error).message}` });
      }
    }

    if (m === "GET" && p === "/orchestrator") {
      const row = db.prepare("SELECT * FROM workers WHERE id = ?").get(ORCH_ID);
      if (!row) return json(res, 404, { error: "orchestrator not started" });
      return json(res, 200, row);
    }

    if (m === "GET" && p === "/session") {
      const orch = db.prepare("SELECT started_at FROM workers WHERE id = 'orchestrator'").get() as Row | undefined;
      const aggr = db.prepare("SELECT COUNT(*) AS total, COUNT(CASE WHEN state IN ('SPAWNING','WORKING','IDLE') THEN 1 END) AS active, COALESCE(SUM(cost_usd), 0) AS total_cost FROM workers").get() as Row | undefined;
      const since = Date.now() - 60 * 60 * 1000;
      const cph = db.prepare("SELECT COALESCE(SUM(json_extract(payload, '$.deltaCost')), 0) AS cph FROM events WHERE type = 'usage' AND ts > ?").get(since) as Row | undefined;
      return json(res, 200, {
        sessionStartTs: orch?.started_at ?? null,
        totalCost: aggr?.total_cost ?? 0,
        costPerHour: cph?.cph ?? 0,
        activeAgents: aggr?.active ?? 0,
        totalAgents: aggr?.total ?? 0,
        now: Date.now(),
      });
    }

    if (m === "POST" && p === "/policy/decide") {
      const body = (await readBody(req)) as {
        worker_id?: string;
        tool_name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
      };
      if (!body.worker_id || !body.tool_name || !body.input) {
        return json(res, 400, { error: "worker_id, tool_name, input required" });
      }
      const decision = await decide(body.worker_id, body.tool_name, body.input, body.tool_use_id);
      return json(res, 200, decision);
    }

    if (m === "GET" && p === "/pending") {
      const rows = db.prepare(`
        SELECT id, worker_id, tool_name, input, created_at, expires_at, resolved, decision, reason
        FROM pending_permissions WHERE resolved = 0 ORDER BY created_at ASC
      `).all();
      return json(res, 200, rows);
    }

    const pendingMatch = p.match(/^\/pending\/([^/]+)\/decision$/);
    if (pendingMatch && m === "POST") {
      const id = pendingMatch[1];
      const body = (await readBody(req)) as {
        decision?: "allow" | "deny";
        reason?: string;
        updatedInput?: Record<string, unknown>;
      };
      const row = db.prepare("SELECT * FROM pending_permissions WHERE id = ?").get(id) as Row | undefined;
      if (!row) return json(res, 404, { error: "pending not found" });
      if (row.resolved) return json(res, 409, { error: "already resolved", decision: row.decision });
      let dec: Decision;
      if (body.decision === "allow") {
        const baseInput = JSON.parse(String(row.input)) as Record<string, unknown>;
        dec = { behavior: "allow", updatedInput: body.updatedInput ?? baseInput };
      } else if (body.decision === "deny") {
        dec = { behavior: "deny", message: body.reason ?? "denied by human" };
      } else {
        return json(res, 400, { error: "decision must be allow or deny" });
      }
      const ok = resolvePending(id, dec);
      if (!ok) return json(res, 409, { error: "expired or already resolved" });
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found", path: p });
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      metrics.bodyTooLarge++;
      log.warn("body too large rejected", { request_id: requestId, method: m, path: p });
      json(res, 413, { error: e.message, limit: MAX_BODY_BYTES });
      return;
    }
    log.error("request failed", { request_id: requestId, method: m, path: p, error: (e as Error).message });
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  log.info("listening", { url: `http://${HOST}:${PORT}`, state: CONFIG.daemon.dbFile, logs: LOG_DIR });
});

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down", { signal: sig, workers: children.size });
  for (const [, child] of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  try { unlinkSync(PID_FILE); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
