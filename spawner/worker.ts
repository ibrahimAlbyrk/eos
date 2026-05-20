#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  mkdtempSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { spawn as ptySpawn } from "@homebridge/node-pty-prebuilt-multiarch";
import chokidar from "chokidar";

const { values } = parseArgs({
  options: {
    cwd: { type: "string" },
    prompt: { type: "string" },
    name: { type: "string" },
    "worktree-from": { type: "string" },
    branch: { type: "string" },
    "keep-worktree": { type: "boolean", default: false },
    "with-gateway": { type: "boolean", default: false },
    port: { type: "string", default: "7421" },
    "daemon-url": { type: "string" },
    "worker-id": { type: "string" },
    persistent: { type: "boolean", default: false },
    "system-prompt-file": { type: "string" },
    "mcp-config": { type: "string" },
    "permission-prompt-tool": { type: "string" },
    "claude-permission-mode": { type: "string" },
    model: { type: "string" },
  },
  strict: true,
});

if (!values.prompt || (!values.cwd && !values["worktree-from"])) {
  console.error("usage: worker.ts (--cwd <dir> | --worktree-from <repo>) --prompt <text> [--branch <name>] [--keep-worktree] [--with-gateway] [--port <n>] [--name <id>]");
  process.exit(1);
}

const name = values.name ?? "w" + Math.random().toString(36).slice(2, 7);
const port = Number(values.port);
const daemonUrl = values["daemon-url"];
const workerId = values["worker-id"];

function emit(type: string, payload?: unknown): void {
  if (!daemonUrl || !workerId) return;
  fetch(`${daemonUrl}/workers/${workerId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, payload }),
  }).catch(() => {});
}

function git(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let repoRoot: string | null = null;
let branch: string | null = null;
let worktreeDir: string | null = null;
let cwd: string;

if (values["worktree-from"]) {
  repoRoot = realpathSync(resolve(values["worktree-from"]));
  const head = git(["rev-parse", "--git-dir"], repoRoot);
  if (head.code !== 0) {
    console.error(`[${name}] not a git repo: ${repoRoot}`);
    process.exit(1);
  }
  branch = values.branch ?? `cm-${name}-${Date.now().toString(36)}`;
  const wtBase = join(repoRoot, ".claude-mgr", "worktrees");
  mkdirSync(wtBase, { recursive: true });
  const wtPath = join(wtBase, branch);
  const add = git(["worktree", "add", wtPath, "-b", branch], repoRoot);
  if (add.code !== 0) {
    console.error(`[${name}] worktree add failed: ${add.stderr.trim()}`);
    process.exit(1);
  }
  worktreeDir = realpathSync(wtPath);
  cwd = worktreeDir;
  console.log(`[${name}] worktree created: ${worktreeDir} on branch ${branch}`);
} else {
  cwd = realpathSync(resolve(values.cwd!));
  mkdirSync(cwd, { recursive: true });
}

const settingsTmpDir = mkdtempSync(join(tmpdir(), `cm-${name}-`));
const settingsPath = join(settingsTmpDir, "settings.json");

const hookConfig = (eventName: string, matcher?: string) => ({
  ...(matcher ? { matcher } : {}),
  hooks: [{ type: "http", url: `http://127.0.0.1:${port}/event?event=${eventName}` }],
});

writeFileSync(
  settingsPath,
  JSON.stringify(
    {
      permissions: {
        defaultMode: "default",
        ask: ["Bash", "Edit", "Write", "WebFetch", "Glob", "Grep"],
      },
      hooks: {
        SessionStart: [hookConfig("SessionStart", "startup")],
        Stop: [hookConfig("Stop")],
        Notification: [hookConfig("Notification")],
        PostToolUse: [hookConfig("PostToolUse")],
        SessionEnd: [hookConfig("SessionEnd")],
      },
    },
    null,
    2
  )
);

console.log(`[${name}] cwd=${cwd} port=${port} settings=${settingsPath}`);

let sessionId: string | null = null;
let jsonlOffset = 0;
let lastJsonlActivityTs = 0;
let lastUserMsgTs = 0;
let lastTurnEndTs = 0;
let pendingShutdown = false;
const events: Array<{ event: string; t: number }> = [];

function encodeCwd(p: string): string {
  return p.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function startTail(sid: string) {
  const jsonlPath = join(homedir(), ".claude", "projects", encodeCwd(cwd), `${sid}.jsonl`);
  console.log(`[${name}] tail=${jsonlPath}`);
  const watcher = chokidar.watch(jsonlPath, { ignoreInitial: false, awaitWriteFinish: false });
  const readNew = () => {
    if (!existsSync(jsonlPath)) return;
    const stat = statSync(jsonlPath);
    if (stat.size <= jsonlOffset) return;
    const fd = openSync(jsonlPath, "r");
    const buf = Buffer.alloc(stat.size - jsonlOffset);
    readSync(fd, buf, 0, buf.length, jsonlOffset);
    closeSync(fd);
    jsonlOffset = stat.size;
    for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        // Claude Code JSONL wraps content blocks inside message objects.
        // Assistant turns can contain BOTH text and tool_use blocks; user turns
        // carry tool_result blocks. Extract all of them.
        if (e.message?.role === "assistant") {
          const usage = e.message?.usage;
          if (usage && (usage.input_tokens || usage.output_tokens || usage.cache_read_input_tokens || usage.cache_creation_input_tokens)) {
            emit("usage", {
              in: usage.input_tokens ?? 0,
              out: usage.output_tokens ?? 0,
              cacheRead: usage.cache_read_input_tokens ?? 0,
              cacheCreate: usage.cache_creation_input_tokens ?? 0,
              model: e.message?.model ?? values.model ?? "opus",
            });
          }
          for (const block of e.message.content ?? []) {
            if (block.type === "text") {
              const text = String(block.text);
              console.log(`[${name}][jsonl] assistant ${text.slice(0, 80).replace(/\s+/g, " ")}`);
              emit("jsonl", { kind: "assistant_text", text });
              lastJsonlActivityTs = Date.now();
            } else if (block.type === "tool_use") {
              console.log(`[${name}][jsonl] tool_use ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 80)}`);
              emit("jsonl", { kind: "tool_use", id: block.id, name: block.name, input: block.input ?? {} });
              lastJsonlActivityTs = Date.now();
            } else if (block.type === "thinking") {
              const text = String(block.thinking ?? block.text ?? "");
              console.log(`[${name}][jsonl] thinking ${text.slice(0, 80).replace(/\s+/g, " ")}`);
              emit("jsonl", { kind: "thinking", text });
              lastJsonlActivityTs = Date.now();
            }
          }
        } else if (e.message?.role === "user") {
          for (const block of e.message.content ?? []) {
            if (block.type === "tool_result") {
              const raw = block.content;
              const text =
                typeof raw === "string"
                  ? raw
                  : Array.isArray(raw)
                    ? raw.map((c: { text?: string }) => c?.text ?? "").join("")
                    : "";
              console.log(`[${name}][jsonl] tool_result ${block.is_error ? "ERR " : ""}${text.slice(0, 80).replace(/\s+/g, " ")}`);
              emit("jsonl", { kind: "tool_result", toolUseId: block.tool_use_id, isError: !!block.is_error, text });
            }
          }
        }
        // Built-in tools (ToolSearch, etc.) deliver their result as a top-level
        // "attachment" entry with type "hook_success", NOT a tool_result block
        // inside a user message. Synthesize a tool_result event from it so the
        // UI can pair it with the matching tool_use by id.
        else if (e.type === "attachment" && e.attachment?.type === "hook_success") {
          const a = e.attachment;
          const text = String(a.content ?? a.stdout ?? "").trim();
          const isError = typeof a.exitCode === "number" && a.exitCode >= 400;
          console.log(`[${name}][jsonl] attachment ${isError ? "ERR " : ""}${text.slice(0, 80).replace(/\s+/g, " ")}`);
          emit("jsonl", { kind: "tool_result", toolUseId: a.toolUseID, isError, text });
        }
        // Legacy top-level event shapes (older Claude Code transcript formats):
        else if (e.type === "tool_use") {
          emit("jsonl", { kind: "tool_use", name: e.name, input: e.input ?? {} });
        } else if (e.type === "tool_result") {
          const text = String(e.content?.[0]?.text ?? "");
          emit("jsonl", { kind: "tool_result", isError: !!e.isError, text });
        }
      } catch {}
    }
  };
  watcher.on("add", readNew).on("change", readNew);
}

function sendToPty(text: string): void {
  if (pendingShutdown) {
    pendingShutdown = false;
    if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  }
  const now = Date.now();
  lastUserMsgTs = now;
  lastJsonlActivityTs = now;
  emit("lifecycle", { phase: "message_received", text: text.slice(0, 200) });
  pty.write(text);
  setTimeout(() => pty.write("\r"), 300);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== "POST") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/message") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as { text?: string };
        if (!body.text) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "text required" }));
          return;
        }
        sendToPty(body.text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
    return;
  }

  const eventName = url.searchParams.get("event") ?? "Unknown";
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(raw); } catch {}
    events.push({ event: eventName, t: Date.now() });

    if (!sessionId && typeof body.session_id === "string") {
      sessionId = body.session_id;
      console.log(`[${name}] captured session=${sessionId} via ${eventName}`);
      startTail(sessionId);
    }
    emit("hook", { event: eventName, body });
    if (eventName === "PostToolUse") {
      console.log(`[${name}][hook] PostToolUse tool=${body.tool_name}`);
    } else if (eventName === "Stop") {
      console.log(`[${name}][hook] Stop`);
      lastTurnEndTs = Date.now();
      if (!values.persistent) scheduleShutdown();
    } else if (eventName === "SessionEnd") {
      console.log(`[${name}][hook] SessionEnd`);
      lastTurnEndTs = Date.now();
      if (!values.persistent) scheduleShutdown();
    } else if (eventName === "Notification") {
      console.log(`[${name}][hook] Notification ${JSON.stringify(body).slice(0, 100)}`);
    } else {
      console.log(`[${name}][hook] ${eventName}`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ continue: true }));
  });
});
server.listen(port, "127.0.0.1");

const claudeArgs: string[] = ["--settings", settingsPath];
if (values["mcp-config"]) {
  claudeArgs.push("--strict-mcp-config", "--mcp-config", values["mcp-config"]);
  if (values["permission-prompt-tool"]) {
    claudeArgs.push("--permission-prompt-tool", values["permission-prompt-tool"]);
  }
} else if (values["with-gateway"]) {
  const mcpPath = join(settingsTmpDir, "mcp.json");
  writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        gateway: {
          command: "/Users/ibrahimalbyrk/.local/bin/bun",
          args: ["run", "/Users/ibrahimalbyrk/Projects/CC/claude-manager/gateway/server.ts"],
          env: daemonUrl && workerId
            ? { ...(process.env as Record<string, string>), CLAUDE_MGR_DAEMON_URL: daemonUrl, CLAUDE_MGR_WORKER_ID: workerId }
            : { ...(process.env as Record<string, string>) },
        },
      },
    })
  );
  claudeArgs.push(
    "--strict-mcp-config",
    "--mcp-config",
    mcpPath,
    "--permission-prompt-tool",
    "mcp__gateway__decide"
  );
}
if (values["system-prompt-file"]) {
  claudeArgs.push("--append-system-prompt-file", values["system-prompt-file"]);
}
if (values["claude-permission-mode"]) {
  claudeArgs.push("--permission-mode", values["claude-permission-mode"]);
}
claudeArgs.push("--model", values.model ?? "opus");

console.log(`[${name}] spawn: claude ${claudeArgs.join(" ")}`);
emit("lifecycle", { phase: "claude_spawning", args: claudeArgs, cwd, worktreeDir, branch });

const pty = ptySpawn("/Users/ibrahimalbyrk/.local/bin/claude", claudeArgs, {
  cwd,
  cols: 120,
  rows: 30,
  env: {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    ...(daemonUrl && workerId
      ? {
          CLAUDE_MGR_SPAWNED: "1",
          CLAUDE_MGR_WORKER_ID: workerId,
          CLAUDE_MGR_DAEMON_URL: daemonUrl,
        }
      : {}),
  },
});

pty.onData((data: string) => process.stdout.write(data));
pty.onExit(({ exitCode }: { exitCode: number }) => {
  console.log(`\n[${name}] pty exit code=${exitCode}`);
  emit("lifecycle", { phase: "pty_exit", code: exitCode });
  cleanup(exitCode ?? 0);
});

setTimeout(() => {
  console.log(`\n[${name}] writing prompt`);
  emit("lifecycle", { phase: "prompt_sent" });
  const now = Date.now();
  lastUserMsgTs = now;
  lastJsonlActivityTs = now;
  pty.write(values.prompt!);
  setTimeout(() => pty.write("\r"), 300);
}, 2500);

// Heartbeat: while a turn is active (user message sent, no Stop hook yet) and
// claude has produced no JSONL commit for a while (typical of long opus
// deliberation), emit a "still alive" event so the UI doesn't go blank.
// Skipped between turns (idle persistent orchestrator stays silent).
const HEARTBEAT_INTERVAL_MS = 8000;
const HEARTBEAT_QUIET_THRESHOLD_MS = 6000;
const heartbeatTimer: ReturnType<typeof setInterval> = setInterval(() => {
  if (pendingShutdown) return;
  if (lastUserMsgTs === 0) return;
  if (lastUserMsgTs <= lastTurnEndTs) return; // turn already finished
  const now = Date.now();
  const quietMs = now - (lastJsonlActivityTs || lastUserMsgTs);
  if (quietMs < HEARTBEAT_QUIET_THRESHOLD_MS) return;
  emit("heartbeat", {
    elapsedMs: now - lastUserMsgTs,
    quietMs,
  });
}, HEARTBEAT_INTERVAL_MS);

let shutdownTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleShutdown() {
  if (pendingShutdown) return;
  pendingShutdown = true;
  shutdownTimer = setTimeout(() => {
    console.log(`[${name}] kill pty`);
    try { pty.kill(); } catch {}
  }, 2500);
}

let cleanedUp = false;
function cleanup(code: number) {
  if (cleanedUp) return;
  cleanedUp = true;
  if (shutdownTimer) clearTimeout(shutdownTimer);
  clearInterval(heartbeatTimer);
  // Make absolutely sure the claude PTY child is signalled — process.exit alone
  // closes the master FD but timing race can leave orphan claude processes.
  try { pty.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, 1500);
  server.close();
  try { rmSync(settingsTmpDir, { recursive: true, force: true }); } catch {}

  console.log(`\n[${name}] events:`);
  for (const e of events) console.log(`  ${new Date(e.t).toISOString().slice(11, 23)}  ${e.event}`);

  if (worktreeDir && repoRoot && branch) {
    const status = git(["status", "--short"], worktreeDir);
    const diffStat = git(["diff", "--stat"], worktreeDir);
    const hasChanges = status.stdout.trim().length > 0;
    console.log(`\n[${name}] worktree summary:`);
    console.log(`  path:    ${worktreeDir}`);
    console.log(`  branch:  ${branch}`);
    console.log(`  status:`);
    (status.stdout.trim() || "(clean)").split("\n").forEach((l) => console.log(`    ${l}`));
    if (diffStat.stdout.trim()) {
      console.log(`  diff stat:`);
      diffStat.stdout.trim().split("\n").forEach((l) => console.log(`    ${l}`));
    }
    if (!hasChanges && !values["keep-worktree"]) {
      console.log(`  no changes — removing worktree`);
      git(["worktree", "remove", worktreeDir, "--force"], repoRoot);
      git(["branch", "-D", branch], repoRoot);
      emit("worktree", { phase: "cleaned", path: worktreeDir, branch });
    } else if (values["keep-worktree"] || hasChanges) {
      console.log(`  (worktree preserved for review; run: git -C ${repoRoot} worktree remove ${worktreeDir})`);
      emit("worktree", { phase: "preserved", path: worktreeDir, branch, status: status.stdout, diffStat: diffStat.stdout });
    }
  }

  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));
