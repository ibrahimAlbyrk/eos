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

const writeQueue = new PtyWriteQueue(pty);
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
const bootCompleteAt = Date.now() + BOOT_DELAY_MS;
let bootBuffer: string[] = [];
let bootCompleted = false;
setTimeout(() => {
  bootCompleted = true;
  for (const t of bootBuffer) writeQueue.enqueue(t);
  bootBuffer = [];
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
    evt.emit("hook", { event: eventName, body });
    if (eventName === "PostToolUse") {
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

// Initial prompt — small delay so claude finishes its boot animation before
// we start typing. The PtyWriteQueue handles the CR-after-text dance.
// Empty prompt (e.g. orchestrators that should idle until the first user
// message) skips the write entirely and lifts the worker straight to IDLE
// so the UI doesn't show it stuck in SPAWNING.
if (opts.prompt && opts.prompt.trim().length > 0) {
  setTimeout(() => {
    console.log(`\n[${name}] writing prompt`);
    evt.emit("lifecycle", { phase: "prompt_sent" });
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    writeQueue.enqueue(opts.prompt);
  }, BOOT_DELAY_MS);
} else {
  setTimeout(() => {
    evt.emit("lifecycle", { phase: "ready_no_prompt" });
    // Only push IDLE if no user message has arrived yet — otherwise we'd
    // overwrite the WORKING state set by the just-dispatched message and
    // confuse the UI. The user_message handler will keep state in WORKING.
    if (state.lastUserMsgTs === 0) {
      evt.emit("state", { state: "IDLE" });
    }
  }, BOOT_DELAY_MS);
}

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
  setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, 1500);
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
});
process.on("unhandledRejection", (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`[${name}] unhandledRejection: ${msg}`);
  evt.emit("lifecycle", { phase: "unhandled_rejection", reason: msg });
});
