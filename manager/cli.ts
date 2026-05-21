#!/usr/bin/env node
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { daemonFetch } from "./shared/http.ts";
import { loadConfig } from "./shared/config.ts";

const CONFIG = loadConfig();
// CLAUDE_MGR_URL is kept as a separate override so callers can point the CLI
// at a non-default daemon without writing a full config.json.
const DAEMON_URL = process.env.CLAUDE_MGR_URL ?? `http://${CONFIG.daemon.host}:${CONFIG.daemon.port}`;
const LOG_DIR = CONFIG.daemon.logDir;
const REPO_ROOT = CONFIG.paths.repoRoot;

// CLI-flavored wrapper: friendly error message + process.exit on failure.
// The library-style throwing variant lives in shared/http.ts as daemonApi().
async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await daemonFetch(DAEMON_URL, method, path, body);
  if (r.networkError) {
    console.error(`error: cannot reach daemon at ${DAEMON_URL} (${r.networkError.message})`);
    console.error(`hint: start daemon with: node --experimental-strip-types ${join(REPO_ROOT, "manager", "daemon.ts")}`);
    process.exit(1);
  }
  if (!r.ok) {
    console.error(`error ${r.status}: ${r.raw}`);
    process.exit(1);
  }
  return r.body;
}

function fmtTs(ts: number | null): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toISOString().slice(11, 19);
}

function fmtDur(start: number, end: number | null): string {
  if (!start) return "-";
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function short(id: string): string {
  return id.length > 10 ? id.slice(0, 10) : id;
}

interface Worker {
  id: string;
  state: string;
  cwd: string | null;
  worktree_from: string | null;
  branch: string | null;
  prompt: string;
  name: string | null;
  pid: number | null;
  port: number;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
}

async function cmdList(): Promise<void> {
  const workers = (await api("GET", "/workers")) as Worker[];
  if (workers.length === 0) {
    console.log("(no workers)");
    return;
  }
  console.log("ID          STATE     DUR    PID    BRANCH/CWD                              PROMPT");
  for (const w of workers) {
    const loc = w.branch ?? (w.cwd ?? "-").slice(-40);
    const prompt = w.prompt.slice(0, 40).replace(/\s+/g, " ");
    console.log(
      `${short(w.id).padEnd(11)} ${w.state.padEnd(9)} ${fmtDur(w.started_at, w.ended_at).padEnd(6)} ${String(w.pid ?? "-").padEnd(6)} ${loc.padEnd(40)} ${prompt}`
    );
  }
}

async function cmdSpawn(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: "string" },
      "worktree-from": { type: "string" },
      branch: { type: "string" },
      prompt: { type: "string" },
      name: { type: "string" },
      "with-gateway": { type: "boolean", default: false },
      model: { type: "string" },
    },
    strict: true,
  });
  if (!values.prompt) {
    console.error("error: --prompt required");
    process.exit(1);
  }
  if (!values.cwd && !values["worktree-from"]) {
    console.error("error: --cwd or --worktree-from required");
    process.exit(1);
  }
  const res = (await api("POST", "/workers", {
    prompt: values.prompt,
    cwd: values.cwd,
    worktreeFrom: values["worktree-from"],
    branch: values.branch,
    name: values.name,
    withGateway: values["with-gateway"],
    model: values.model,
  })) as { id: string; port: number };
  console.log(`spawned: ${res.id}  port=${res.port}`);
  console.log(`logs: ${join(LOG_DIR, res.id + ".log")}`);
}

async function cmdShow(id: string): Promise<void> {
  const w = (await api("GET", `/workers/${id}`)) as Worker;
  console.log(`id:         ${w.id}`);
  console.log(`state:      ${w.state}`);
  console.log(`name:       ${w.name ?? "-"}`);
  console.log(`pid:        ${w.pid ?? "-"}`);
  console.log(`port:       ${w.port}`);
  console.log(`cwd:        ${w.cwd ?? "-"}`);
  console.log(`worktree:   ${w.worktree_from ?? "-"}  branch=${w.branch ?? "-"}`);
  console.log(`duration:   ${fmtDur(w.started_at, w.ended_at)}`);
  console.log(`prompt:     ${w.prompt}`);
  if (w.exit_code !== null) {
    const label = w.exit_code === 129 ? "completed"
                : w.exit_code === 143 ? "killed"
                : w.exit_code === 0 ? "exit=0"
                : `exit=${w.exit_code}`;
    console.log(`exit_code:  ${label}`);
  }

  const events = (await api("GET", `/workers/${id}/events?limit=50`)) as Array<{
    ts: number;
    type: string;
    payload: string | null;
  }>;
  console.log(`\nrecent events (${events.length}):`);
  for (const e of events) {
    let payload = "";
    if (e.payload) {
      try {
        const p = JSON.parse(e.payload);
        if (e.type === "hook") payload = ` event=${p.event}`;
        else if (e.type === "state") payload = ` -> ${p.state}`;
        else if (e.type === "jsonl") {
          if (p.kind === "tool_use") payload = ` ${p.name}: ${JSON.stringify(p.input).slice(0, 60)}`;
          else if (p.kind === "tool_result") payload = ` ${p.isError ? "ERR " : ""}${(p.text || "").slice(0, 60)}`;
          else if (p.kind === "assistant_text") payload = `: ${(p.text || "").slice(0, 60).replace(/\s+/g, " ")}`;
        } else if (e.type === "lifecycle") payload = ` ${p.phase}`;
        else if (e.type === "worktree") payload = ` ${p.phase}`;
        else if (e.type === "exit") payload = ` code=${p.code}`;
        else payload = " " + JSON.stringify(p).slice(0, 80);
      } catch {
        payload = " " + (e.payload || "").slice(0, 60);
      }
    }
    console.log(`  ${fmtTs(e.ts)}  ${e.type.padEnd(10)}${payload}`);
  }
}

function cmdLogs(id: string, follow: boolean): void {
  const path = join(LOG_DIR, `${id}.log`);
  if (!existsSync(path)) {
    console.error(`no log file: ${path}`);
    process.exit(1);
  }
  if (follow) {
    const child = spawn("tail", ["-f", path], { stdio: "inherit" });
    process.on("SIGINT", () => child.kill());
  } else {
    createReadStream(path).pipe(process.stdout);
  }
}

async function cmdKill(id: string): Promise<void> {
  const res = (await api("DELETE", `/workers/${id}`)) as { killing?: boolean; error?: string };
  if (res.killing) console.log(`killing ${id}`);
  else console.log(JSON.stringify(res));
}

interface Pending {
  id: string;
  worker_id: string;
  tool_name: string;
  input: string;
  created_at: number;
  expires_at: number;
}

async function cmdPending(): Promise<void> {
  const rows = (await api("GET", "/pending")) as Pending[];
  if (rows.length === 0) {
    console.log("(no pending)");
    return;
  }
  const now = Date.now();
  console.log("ID           WORKER       TOOL    EXPIRES IN  INPUT");
  for (const r of rows) {
    const secs = Math.max(0, Math.round((r.expires_at - now) / 1000));
    let input = "";
    try {
      const i = JSON.parse(r.input);
      input = (i.command ?? i.file_path ?? i.url ?? JSON.stringify(i)).slice(0, 50);
    } catch { input = r.input.slice(0, 50); }
    console.log(`${r.id.padEnd(12)} ${short(r.worker_id).padEnd(12)} ${r.tool_name.padEnd(7)} ${(secs + "s").padEnd(11)} ${input}`);
  }
}

async function cmdApprove(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { rewrite: { type: "string" } },
  });
  const id = positionals[0];
  if (!id) { console.error("usage: approve <pending-id> [--rewrite '<json>']"); process.exit(1); }
  const body: Record<string, unknown> = { decision: "allow" };
  if (values.rewrite) {
    try { body.updatedInput = JSON.parse(values.rewrite); }
    catch { console.error("--rewrite must be valid JSON"); process.exit(1); }
  }
  const res = await api("POST", `/pending/${id}/decision`, body);
  console.log(JSON.stringify(res));
}

async function cmdDeny(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { reason: { type: "string" } },
  });
  const id = positionals[0];
  if (!id) { console.error("usage: deny <pending-id> [--reason '<text>']"); process.exit(1); }
  const res = await api("POST", `/pending/${id}/decision`, { decision: "deny", reason: values.reason ?? "denied" });
  console.log(JSON.stringify(res));
}

interface Orchestrator {
  id: string;
  name: string | null;
  cwd: string | null;
  state: string;
  started_at: number;
  ended_at: number | null;
  is_orchestrator: number;
}

async function cmdOrchestrator(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "new" || sub === "create") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        cwd: { type: "string" },
        name: { type: "string" },
        model: { type: "string" },
      },
      strict: true,
    });
    if (!values.cwd) { console.error("error: --cwd required"); process.exit(1); }
    const res = (await api("POST", "/orchestrators", {
      name: values.name,
      cwd: values.cwd,
      model: values.model,
    })) as { id: string; port: number; name?: string };
    console.log(`spawned orchestrator: ${res.id}  name=${res.name ?? values.name ?? "(auto)"}  cwd=${values.cwd}`);
    return;
  }
  if (sub === "list" || sub === "ls" || sub === undefined) {
    const rows = (await api("GET", "/orchestrators")) as Orchestrator[];
    if (rows.length === 0) { console.log("(no orchestrators)"); return; }
    console.log("ID         NAME                 STATE     DUR    CWD");
    for (const o of rows) {
      console.log(
        `${o.id.padEnd(10)} ${(o.name ?? "-").slice(0, 20).padEnd(20)} ${o.state.padEnd(9)} ${fmtDur(o.started_at, o.ended_at).padEnd(6)} ${o.cwd ?? "-"}`
      );
    }
    return;
  }
  console.error("usage: orchestrator [list | new --cwd <path> --name <n> [--model opus]]");
  process.exit(1);
}

// Resolve which orchestrator to chat with. Explicit --to wins; otherwise auto-pick
// when exactly one ACTIVE orchestrator exists; error on 0 or 2+. DONE rows are
// historical and ignored for auto-targeting.
async function resolveChatTarget(explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const rows = (await api("GET", "/orchestrators")) as Orchestrator[];
  const active = rows.filter(o => o.state !== "DONE");
  if (active.length === 0) {
    console.error("error: no active orchestrator. Create one with: claude-manager orchestrator new --cwd <path> --name <n>");
    process.exit(1);
  }
  if (active.length === 1) return active[0].id;
  console.error("error: multiple orchestrators running — specify with --to <id>");
  for (const o of active) console.error(`  ${o.id}  ${o.name ?? "-"}  ${o.cwd ?? "-"}`);
  process.exit(1);
}

function help(): void {
  console.log(`claude-manager — orchestration CLI for Claude Code workers

usage:
  claude-manager daemon [start|stop|status]        manage the daemon
  claude-manager web                               launch web UI in browser (starts daemon if needed)

  claude-manager orchestrator new --cwd <path> [--name <n>] [--model opus|sonnet|haiku]
                                                   create a new orchestrator in <path> (name auto-generated if blank)
  claude-manager orchestrator list                 list orchestrators
  claude-manager chat [--to <orch-id>] <message...>
                                                   send a message to an orchestrator (auto-target when exactly one exists)

  claude-manager list                              list workers
  claude-manager spawn --cwd <dir> --prompt <text> spawn worker in <dir>
  claude-manager spawn --worktree-from <repo> --prompt <text> [--branch <b>]
                                                   spawn worker in new worktree
  claude-manager show <id>                         worker/orchestrator detail + recent events
  claude-manager logs <id> [-f]                    stdout/stderr (use -f to follow)
  claude-manager kill <id>                         terminate worker or orchestrator

  claude-manager pending                           list pending permission requests
  claude-manager approve <pending-id> [--rewrite '<json>']
                                                   approve a pending request (optional rewritten input)
  claude-manager deny <pending-id> [--reason '<text>']
                                                   deny a pending request

  claude-manager config [print|init]               dump merged config or write default config.json
  claude-manager doctor                            environment + daemon sanity checks

env:
  CLAUDE_MGR_URL        daemon URL (default http://127.0.0.1:7400)
  CLAUDE_MGR_LOG_LEVEL  debug | info | warn | error (default info)
`);
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "list":
  case "ls":
    await cmdList();
    break;
  case "spawn":
    await cmdSpawn(rest);
    break;
  case "show":
  case "info":
    if (!rest[0]) { console.error("usage: show <id>"); process.exit(1); }
    await cmdShow(rest[0]);
    break;
  case "logs":
    if (!rest[0]) { console.error("usage: logs <id> [-f]"); process.exit(1); }
    cmdLogs(rest[0], rest.includes("-f") || rest.includes("--follow"));
    break;
  case "kill":
  case "stop":
    if (!rest[0]) { console.error("usage: kill <id>"); process.exit(1); }
    await cmdKill(rest[0]);
    break;
  case "daemon":
    {
      const sub = rest[0] ?? "start";
      if (sub === "start") {
        const child = spawn("node", ["--no-warnings", "--experimental-strip-types", join(REPO_ROOT, "manager", "daemon.ts")], {
          stdio: "inherit",
        });
        child.on("exit", (c) => process.exit(c ?? 0));
        process.on("SIGINT", () => child.kill("SIGINT"));
        process.on("SIGTERM", () => child.kill("SIGTERM"));
      } else if (sub === "stop") {
        const pidFile = CONFIG.daemon.pidFile;
        if (!existsSync(pidFile)) { console.log("(no daemon running)"); break; }
        const pid = Number((await import("node:fs")).readFileSync(pidFile, "utf8").trim());
        try {
          process.kill(pid, "SIGTERM");
          console.log(`sent SIGTERM to daemon pid=${pid}`);
        } catch (e) {
          console.log(`daemon pid=${pid} not alive (${(e as Error).message}); cleaning pid file`);
          try { (await import("node:fs")).unlinkSync(pidFile); } catch {}
        }
      } else if (sub === "status") {
        try {
          const r = await fetch(`${DAEMON_URL}/health`);
          if (r.ok) console.log(`daemon up at ${DAEMON_URL}`);
          else console.log(`daemon at ${DAEMON_URL} returned ${r.status}`);
        } catch (e) {
          console.log(`daemon not reachable at ${DAEMON_URL}: ${(e as Error).message}`);
        }
      } else {
        console.error("usage: claude-manager daemon [start|stop|status]");
        process.exit(1);
      }
    }
    break;
  case "chat":
    {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { to: { type: "string" } },
        strict: true,
      });
      const text = positionals.join(" ").trim();
      if (!text) { console.error("usage: chat [--to <orchestrator-id>] <message...>"); process.exit(1); }
      const targetId = await resolveChatTarget(values.to);
      const res = await api("POST", `/orchestrators/${targetId}/message`, { text });
      console.log(JSON.stringify(res));
    }
    break;
  case "orchestrator":
  case "orch":
    await cmdOrchestrator(rest);
    break;
  case "tui":
    {
      const tsxBin = join(REPO_ROOT, "manager", "node_modules", ".bin", "tsx");
      const child = spawn(tsxBin, [join(REPO_ROOT, "manager", "tui.tsx")], { stdio: "inherit" });
      child.on("exit", (c) => process.exit(c ?? 0));
      child.on("error", (e) => {
        console.error(`failed to launch TUI: ${e.message}`);
        console.error(`run: (cd ${join(REPO_ROOT, "manager")} && bun install)`);
        process.exit(1);
      });
    }
    break;
  case "web":
    {
      // 1) Make sure daemon is up
      let alive = false;
      try {
        const r = await fetch(`${DAEMON_URL}/health`);
        alive = r.ok;
      } catch {}
      if (!alive) {
        console.log("starting daemon…");
        const child = spawn(
          "node",
          ["--no-warnings", "--experimental-strip-types", join(REPO_ROOT, "manager", "daemon.ts")],
          { stdio: ["ignore", "ignore", "ignore"], detached: true }
        );
        child.unref();
        // Poll for readiness
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 250));
          try {
            const r = await fetch(`${DAEMON_URL}/health`);
            if (r.ok) { alive = true; break; }
          } catch {}
        }
        if (!alive) {
          console.error("daemon failed to start — see ~/.claude-mgr/logs or run `claude-manager daemon start` manually");
          process.exit(1);
        }
      }
      const webUrl = `${DAEMON_URL}/web/`;
      console.log(`claude-manager web → ${webUrl}`);
      // 2) Open in default browser (best-effort)
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try {
        const op = spawn(opener, [webUrl], { stdio: "ignore", detached: true });
        op.unref();
      } catch {
        console.log(`open the URL above in your browser.`);
      }
    }
    break;
  case "pending":
    await cmdPending();
    break;
  case "approve":
    await cmdApprove(rest);
    break;
  case "deny":
    await cmdDeny(rest);
    break;
  case "config": {
    const sub = rest[0];
    if (sub === "print" || sub === undefined) {
      console.log(JSON.stringify(CONFIG, null, 2));
      break;
    }
    if (sub === "init") {
      const { writeDefaultConfig } = await import("./shared/config.ts");
      const path = writeDefaultConfig();
      console.log(`wrote ${path}`);
      console.log("edit it, then restart the daemon for changes to take effect.");
      break;
    }
    console.error(`unknown config subcommand: ${sub} (use: print, init)`);
    process.exit(1);
    break;
  }
  case "doctor": {
    // Lightweight environmental check — no daemon round-trip required for FS
    // probes; only hits the daemon if it's actually up.
    const { readdirSync, statSync: fsStatSync } = await import("node:fs");
    const { execSync: shell } = await import("node:child_process");
    const home = CONFIG.daemon.home;
    const issues: string[] = [];
    const ok = (m: string) => console.log(`  ✓ ${m}`);
    const warn = (m: string) => { issues.push(m); console.log(`  ⚠ ${m}`); };

    console.log("claude-manager doctor\n");

    // Daemon reachable?
    let daemonUp = false;
    try {
      const r = await fetch(`${DAEMON_URL}/health`);
      daemonUp = r.ok;
    } catch {}
    if (daemonUp) ok(`daemon reachable at ${DAEMON_URL}`);
    else warn(`daemon not reachable at ${DAEMON_URL} (start it with: claude-manager daemon start)`);

    // ~/.claude-mgr structure
    try {
      const s = fsStatSync(home);
      if (s.isDirectory()) ok(`home dir exists: ${home}`);
      else warn(`home dir is not a directory: ${home}`);
    } catch { warn(`home dir missing: ${home}`); }

    // DB size
    try {
      const s = fsStatSync(CONFIG.daemon.dbFile);
      const mb = (s.size / (1024 * 1024)).toFixed(1);
      ok(`state.db size: ${mb} MB`);
      if (s.size > 500 * 1024 * 1024) warn(`state.db is large (>500MB); consider archiving old workers`);
    } catch { warn(`state.db missing: ${CONFIG.daemon.dbFile}`); }

    // Log dir size
    try {
      let total = 0;
      for (const f of readdirSync(CONFIG.daemon.logDir)) {
        try { total += fsStatSync(join(CONFIG.daemon.logDir, f)).size; } catch {}
      }
      const mb = (total / (1024 * 1024)).toFixed(1);
      ok(`logs dir size: ${mb} MB`);
      if (total > 1024 * 1024 * 1024) warn(`logs dir >1GB — rotate or clean old worker logs`);
    } catch {}

    // Orphan claude/worker processes (cm- prefix from worker.ts mkdtempSync)
    try {
      const out = shell(`pgrep -f "cm-" 2>/dev/null || true`, { encoding: "utf8" });
      const pids = out.split(/\s+/).filter(Boolean);
      if (daemonUp) {
        const ws = await fetch(`${DAEMON_URL}/workers`).then((r) => r.json()) as Array<{ pid?: number }>;
        const known = new Set(ws.map((w) => w.pid).filter((x): x is number => typeof x === "number"));
        const orphans = pids.map(Number).filter((p) => !known.has(p));
        if (orphans.length > 0) warn(`${orphans.length} orphan cm-* processes (pids: ${orphans.slice(0, 5).join(", ")}...)`);
        else ok(`no orphan cm-* processes`);
      } else if (pids.length > 0) {
        warn(`${pids.length} cm-* processes running but daemon is down — likely orphans`);
      }
    } catch {}

    // Stuck pending permissions
    if (daemonUp) {
      try {
        const pending = await fetch(`${DAEMON_URL}/pending`).then((r) => r.json()) as Array<{ expires_at: number }>;
        const now = Date.now();
        const stuck = pending.filter((p) => p.expires_at < now).length;
        if (stuck > 0) warn(`${stuck} pending permission(s) past TTL — daemon should have swept these`);
        else ok(`pending permissions clean (${pending.length} active, none expired)`);
      } catch {}
    }

    console.log(`\n${issues.length === 0 ? "all good." : `${issues.length} issue(s) to review.`}`);
    process.exit(issues.length === 0 ? 0 : 1);
    break;
  }
  case undefined:
  case "help":
  case "-h":
  case "--help":
    help();
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    help();
    process.exit(1);
}
