#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdirSync, createWriteStream, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { parse as parseYaml } from "yaml";

const PORT = Number(process.env.CLAUDE_MGR_PORT ?? "7400");
const DAEMON_DIR = join(homedir(), ".claude-mgr");
const LOG_DIR = join(DAEMON_DIR, "logs");
const PID_FILE = join(DAEMON_DIR, "daemon.pid");
const REPO_ROOT = "/Users/ibrahimalbyrk/Projects/CC/claude-manager";
const WORKER_SCRIPT = join(REPO_ROOT, "spawner", "worker.ts");

mkdirSync(LOG_DIR, { recursive: true });
try { writeFileSync(PID_FILE, String(process.pid)); } catch {}

const db = new DatabaseSync(join(DAEMON_DIR, "state.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
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
    exit_code INTEGER,
    parent_id TEXT,
    model TEXT
  )
`);
// Live-migrate older DBs that may lack the new columns.
try { db.exec("ALTER TABLE workers ADD COLUMN parent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE workers ADD COLUMN model TEXT"); } catch {}
try { db.exec("ALTER TABLE workers ADD COLUMN tokens_in INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE workers ADD COLUMN tokens_out INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE workers ADD COLUMN tokens_cache_read INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE workers ADD COLUMN tokens_cache_create INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE workers ADD COLUMN cost_usd REAL DEFAULT 0"); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT
  )
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_events_worker_ts ON events(worker_id, ts)");
db.exec(`
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
`);
db.exec("CREATE INDEX IF NOT EXISTS idx_pending_unresolved ON pending_permissions(resolved, expires_at)");

// Per-million-token pricing in USD. Mirrors public Anthropic API rates.
// Cache-read is heavily discounted (~10% of input); cache-create is a slight premium.
interface ModelPrice { in: number; out: number; cacheRead: number; cacheCreate: number; }
const MODEL_PRICES: Record<string, ModelPrice> = {
  "opus":   { in: 15.0, out: 75.0, cacheRead: 1.50, cacheCreate: 18.75 },
  "sonnet": { in:  3.0, out: 15.0, cacheRead: 0.30, cacheCreate:  3.75 },
  "haiku":  { in:  1.0, out:  5.0, cacheRead: 0.10, cacheCreate:  1.25 },
};
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

type PolicyAction = "allow" | "deny" | "ask" | "rewrite";
interface PolicyRule {
  tool?: string | string[];
  action: PolicyAction;
  reason?: string;
  rewriteField?: string;
  rewriteFrom?: string;
  rewriteTo?: string;
  [k: string]: unknown;
}
interface Policy {
  default: PolicyAction;
  ttlMs: number;
  rules: PolicyRule[];
}

function loadPolicy(): Policy {
  const candidates = [
    join(DAEMON_DIR, "policy.yaml"),
    join(REPO_ROOT, "manager", "policy.example.yaml"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const parsed = parseYaml(readFileSync(p, "utf8"));
      console.log(`[daemon] policy loaded from ${p} (${parsed.rules?.length ?? 0} rules)`);
      return {
        default: parsed.default ?? "ask",
        ttlMs: parsed.ttlMs ?? 30000,
        rules: parsed.rules ?? [],
      };
    }
  }
  console.log("[daemon] no policy file found; default=ask, no rules");
  return { default: "ask", ttlMs: 30000, rules: [] };
}
let policy = loadPolicy();

const RESERVED_RULE_KEYS = new Set(["tool", "action", "reason", "rewriteField", "rewriteFrom", "rewriteTo"]);

function ruleMatches(rule: PolicyRule, toolName: string, input: Record<string, unknown>): boolean {
  if (rule.tool) {
    const tools = Array.isArray(rule.tool) ? rule.tool : [rule.tool];
    if (!tools.includes(toolName)) return false;
  }
  for (const [k, v] of Object.entries(rule)) {
    if (RESERVED_RULE_KEYS.has(k)) continue;
    const fieldValue = String(input[k] ?? "");
    try {
      if (!new RegExp(v as string).test(fieldValue)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

type Decision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }
  | { behavior: "ask" };

function evaluatePolicy(toolName: string, input: Record<string, unknown>): Decision {
  for (const rule of policy.rules) {
    if (!ruleMatches(rule, toolName, input)) continue;
    if (rule.action === "allow") return { behavior: "allow", updatedInput: input };
    if (rule.action === "deny") return { behavior: "deny", message: rule.reason ?? "denied by policy" };
    if (rule.action === "ask") return { behavior: "ask" };
    if (rule.action === "rewrite") {
      const field = rule.rewriteField ?? "command";
      if (!rule.rewriteFrom || !rule.rewriteTo) return { behavior: "deny", message: "malformed rewrite rule" };
      try {
        const next = String(input[field] ?? "").replace(new RegExp(rule.rewriteFrom), rule.rewriteTo);
        return { behavior: "allow", updatedInput: { ...input, [field]: next } };
      } catch {
        return { behavior: "deny", message: "rewrite regex failed" };
      }
    }
  }
  if (policy.default === "allow") return { behavior: "allow", updatedInput: input };
  if (policy.default === "deny") return { behavior: "deny", message: "no rule matched (default deny)" };
  return { behavior: "ask" };
}

const pendingResolvers = new Map<string, (d: Decision) => void>();

function newPendingId(): string {
  return "p-" + Math.random().toString(36).slice(2, 10);
}

async function decide(workerId: string, toolName: string, input: Record<string, unknown>, toolUseId: string | undefined): Promise<Decision> {
  let decision = evaluatePolicy(toolName, input);
  logEvent(workerId, "policy", { tool: toolName, decision: decision.behavior });

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

async function findFreePort(start = 7500): Promise<number> {
  for (let p = start; p < start + 200; p++) {
    if (usedPorts.has(p)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const sock = createConnection({ port: p, host: "127.0.0.1", timeout: 50 });
      sock.once("connect", () => { sock.destroy(); resolve(false); });
      sock.once("error", () => resolve(true));
      sock.once("timeout", () => { sock.destroy(); resolve(true); });
    });
    if (free) { usedPorts.add(p); return p; }
  }
  throw new Error("no free port");
}

function logEvent(workerId: string, type: string, payload?: unknown): void {
  db.prepare("INSERT INTO events (worker_id, ts, type, payload) VALUES (?, ?, ?, ?)")
    .run(workerId, Date.now(), type, payload === undefined ? null : JSON.stringify(payload));
  broadcast(`event:${type}:${workerId}`);
}

function setState(workerId: string, state: string): void {
  const cur = db.prepare("SELECT state FROM workers WHERE id = ?").get(workerId) as Row | undefined;
  if (cur && cur.state === state) return; // suppress redundant transitions
  db.prepare("UPDATE workers SET state = ? WHERE id = ?").run(state, workerId);
  logEvent(workerId, "state", { state });
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
}

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

  const child = spawn("node", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);

  children.set(id, child);

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
    usedPorts.delete(port);
    broadcast("worker:exit");
  });

  broadcast("worker:spawn");

  return { id, port };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const m = req.method ?? "GET";
  const p = url.pathname;

  try {
    if (m === "GET" && p === "/health") return json(res, 200, { ok: true });

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
      }, 25000);
      req.on("close", () => { sseClients.delete(res); clearInterval(ka); });
      return;
    }

    // Static web UI under /web/*
    if (m === "GET" && (p === "/web" || p === "/web/" || p.startsWith("/web/"))) {
      let rel = p === "/web" || p === "/web/" ? "/index.html" : p.slice(4);
      const webRoot = join(REPO_ROOT, "manager", "web");
      const full = join(webRoot, rel);
      if (!full.startsWith(webRoot) || !existsSync(full)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const ext = rel.split(".").pop() || "";
      const mime =
        ext === "html" ? "text/html; charset=utf-8" :
        ext === "css"  ? "text/css; charset=utf-8" :
        ext === "jsx"  ? "text/javascript; charset=utf-8" :
        ext === "js"   ? "text/javascript; charset=utf-8" :
        ext === "json" ? "application/json; charset=utf-8" :
        ext === "svg"  ? "image/svg+xml" :
        "application/octet-stream";
      res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
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
          const pattern = `cm-${w.name || id}-`;
          const out = execSync(`pgrep -f "${pattern}" 2>/dev/null || true`, { encoding: "utf8" });
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
            db.prepare("UPDATE workers SET state = ? WHERE id = ?").run(newState, id);
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
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[daemon] listening http://127.0.0.1:${PORT}`);
  console.log(`[daemon] state: ${join(DAEMON_DIR, "state.db")}`);
  console.log(`[daemon] logs:  ${LOG_DIR}`);
});

let shuttingDown = false;
function shutdown(sig: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[daemon] ${sig} — killing ${children.size} workers`);
  for (const [, child] of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  try { unlinkSync(PID_FILE); } catch {}
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
