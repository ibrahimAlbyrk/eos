#!/usr/bin/env node
// Worker entrypoint — composition root only. Each concern lives in a
// neighbour module: options.ts (CLI parsing), events.ts (daemon RPC),
// worktree.ts (git lifecycle), settings.ts (claude settings.json),
// claude-args.ts (argv composition), pty-queue.ts (serialized writes),
// tail.ts (JSONL chokidar), ingest.ts (local HTTP), session.ts (state +
// heartbeat + shutdown scheduling).

import { rmSync } from "node:fs";
import { spawn as ptySpawn } from "@homebridge/node-pty-prebuilt-multiarch";

import { parseWorkerOptions } from "./options.ts";
import { createDaemonEventClient } from "./events.ts";
import { setupWorktree, teardownWorktree } from "./worktree.ts";
import { buildClaudeSettings } from "./settings.ts";
import { buildClaudeArgs } from "./claude-args.ts";
import { PtyWriteQueue } from "./pty-queue.ts";
import { startJsonlTail, type TailHandle } from "./tail.ts";
import { startIngestServer } from "./ingest.ts";
import {
  newSessionState,
  startHeartbeat,
  createShutdownScheduler,
} from "./session.ts";

const opts = parseWorkerOptions();
const name = opts.name ?? "w" + Math.random().toString(36).slice(2, 7);

const evt = createDaemonEventClient(opts.daemonUrl, opts.workerId);
const wt = setupWorktree({
  worktreeFrom: opts.worktreeFrom,
  cwd: opts.cwd,
  name,
  branch: opts.branch,
}, (m) => console.log(`[${name}] ${m}`));

const settings = buildClaudeSettings(name, opts.port);
const claudeArgs = buildClaudeArgs(opts, settings.tmpDir, settings.settingsPath, {
  daemonUrl: opts.daemonUrl,
  workerId: opts.workerId,
});

console.log(`[${name}] cwd=${wt.cwd} port=${opts.port} settings=${settings.settingsPath}`);

const state = newSessionState();
let tailHandle: TailHandle | null = null;

// PTY ----------------------------------------------------------------------

const claudeBin = process.env.CLAUDE_MGR_CLAUDE_BIN || "claude";
console.log(`[${name}] spawn: claude ${claudeArgs.args.join(" ")}`);
evt.emit("lifecycle", {
  phase: "claude_spawning",
  args: claudeArgs.args,
  cwd: wt.cwd,
  worktreeDir: wt.worktreeDir,
  branch: wt.branch,
});

const pty = ptySpawn(claudeBin, claudeArgs.args, {
  cwd: wt.cwd,
  cols: 120,
  rows: 30,
  env: {
    ...(process.env as Record<string, string>),
    TERM: "xterm-256color",
    ...(opts.daemonUrl && opts.workerId
      ? {
          CLAUDE_MGR_SPAWNED: "1",
          CLAUDE_MGR_WORKER_ID: opts.workerId,
          CLAUDE_MGR_DAEMON_URL: opts.daemonUrl,
        }
      : {}),
  },
});

const writeQueue = new PtyWriteQueue(pty, (err) => {
  console.error(`[${name}] pty write error: ${err instanceof Error ? err.message : err}`);
});
pty.onData((data: string) => process.stdout.write(data));

// Lifecycle ----------------------------------------------------------------

const shutdown = createShutdownScheduler({
  graceMs: 2500,
  state,
  killPty: (): void => { try { pty.kill(); } catch {} },
  name,
});

const heartbeat = startHeartbeat({
  intervalMs: 8000,
  quietThresholdMs: 6000,
  state,
  emit: (t, p) => evt.emit(t, p),
});

// Ingest server (message + hook) ------------------------------------------

// Messages that arrive before claude has finished its boot animation get
// eaten by the TUI (cursor positioning swallows the CR). We buffer any
// pre-boot writes here and flush them once the boot delay has elapsed.
const BOOT_DELAY_MS = 2500;
let bootBuffer: string[] = [];
let bootCompleted = false;
setTimeout(() => {
  bootCompleted = true;
  for (const t of bootBuffer) writeQueue.enqueue(t);
  bootBuffer = [];

  if (opts.prompt && opts.prompt.trim().length > 0) {
    console.log(`\n[${name}] writing prompt`);
    evt.emit("lifecycle", { phase: "prompt_sent" });
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    writeQueue.enqueue(opts.prompt);
  } else {
    evt.emit("lifecycle", { phase: "ready_no_prompt" });
    if (state.lastUserMsgTs === 0) {
      evt.emit("state", { state: "IDLE" });
    }
  }
}, BOOT_DELAY_MS);

function dispatchToPty(text: string): void {
  if (bootCompleted) writeQueue.enqueue(text);
  else bootBuffer.push(text);
}

const ingest = startIngestServer(opts.port, {
  onMessage(text): void {
    shutdown.cancel();
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    evt.emit("lifecycle", { phase: "message_received", text: text.slice(0, 200) });
    dispatchToPty(text);
  },
  onInterrupt(): { ok: boolean } {
    pty.write("\x1b");
    state.lastTurnEndTs = Date.now();
    evt.emit("lifecycle", { phase: "interrupted" });
    return { ok: true };
  },
  onHook(eventName, body): void {
    state.events.push({ event: eventName, t: Date.now() });
    if (!state.sessionId && typeof body.session_id === "string") {
      state.sessionId = body.session_id;
      console.log(`[${name}] captured session=${state.sessionId} via ${eventName}`);
      tailHandle = startJsonlTail({
        cwd: wt.cwd,
        sessionId: state.sessionId,
        defaultModel: opts.model,
        name,
        onEvent: (t, p) => evt.emit(t, p),
        onActivity: (): void => { state.lastJsonlActivityTs = Date.now(); },
      });
    }
    if (eventName === "PreToolUse") {
      evt.emit("tool_running", {
        toolName: body.tool_name ?? "unknown",
        toolUseId: body.tool_use_id ?? null,
        input: body.tool_input ?? {},
      });
    }
    evt.emit("hook", { event: eventName, body });
    if (eventName === "PreToolUse") {
      console.log(`[${name}][hook] PreToolUse tool=${body.tool_name}`);
    } else if (eventName === "PostToolUse") {
      console.log(`[${name}][hook] PostToolUse tool=${body.tool_name}`);
    } else if (eventName === "Stop") {
      console.log(`[${name}][hook] Stop`);
      state.lastTurnEndTs = Date.now();
      if (!opts.persistent) shutdown.schedule();
    } else if (eventName === "SessionEnd") {
      console.log(`[${name}][hook] SessionEnd`);
      state.lastTurnEndTs = Date.now();
      if (!opts.persistent) shutdown.schedule();
    } else if (eventName === "Notification") {
      console.log(`[${name}][hook] Notification ${JSON.stringify(body).slice(0, 100)}`);
    } else {
      console.log(`[${name}][hook] ${eventName}`);
    }
  },
});

// Exit + cleanup ----------------------------------------------------------

pty.onExit(({ exitCode }: { exitCode: number }) => {
  console.log(`\n[${name}] pty exit code=${exitCode}`);
  evt.emit("lifecycle", { phase: "pty_exit", code: exitCode });
  cleanup(exitCode ?? 0);
});

function cleanup(code: number): void {
  if (state.cleanedUp) return;
  state.cleanedUp = true;
  heartbeat.stop();
  shutdown.cancel();
  if (tailHandle) { tailHandle.close(); tailHandle = null; }
  // Make absolutely sure the claude PTY child is signalled — process.exit
  // alone closes the master FD but a timing race can leave orphan claude
  // processes.
  try { pty.kill("SIGTERM"); } catch {}
  const killTimer = setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, 1500);
  killTimer.unref();
  ingest.close();
  try { rmSync(settings.tmpDir, { recursive: true, force: true }); } catch {}

  console.log(`\n[${name}] events:`);
  for (const e of state.events) {
    console.log(`  ${new Date(e.t).toISOString().slice(11, 23)}  ${e.event}`);
  }

  teardownWorktree({
    ctx: wt,
    name,
    keep: opts.keepWorktree,
    emit: (t, p) => evt.emit(t, p),
  });

  process.exit(code);
}

process.on("SIGINT", () => cleanup(130));
process.on("SIGTERM", () => cleanup(143));

process.on("uncaughtException", (e: Error) => {
  console.error(`[${name}] uncaughtException: ${e.message}\n${e.stack ?? ""}`);
  evt.emit("lifecycle", { phase: "uncaught_exception", error: e.message });
  cleanup(1);
});
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[${name}] unhandledRejection: ${msg}`);
  evt.emit("lifecycle", { phase: "unhandled_rejection", reason: msg });
  cleanup(1);
});
