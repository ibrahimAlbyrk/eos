#!/usr/bin/env node
// Worker entrypoint — composition root only. Each concern lives in a
// neighbour module: options.ts (CLI parsing), events.ts (daemon RPC),
// worktree.ts (git lifecycle), settings.ts (claude settings.json),
// claude-args.ts (argv composition), pty-queue.ts (serialized writes),
// tail.ts (JSONL chokidar), ingest.ts (local HTTP), session.ts (state +
// heartbeat + shutdown scheduling).

import { rmSync } from "node:fs";
import { spawn as ptySpawn } from "@homebridge/node-pty-prebuilt-multiarch";

import { WORKER_EXIT } from "../contracts/src/util.ts";
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
import { createReadinessGate } from "./readiness-gate.ts";
import { createPromptAckWatchdog } from "./prompt-ack.ts";
import { resolveParentAgentToolUseId } from "./subagent-meta.ts";

// Timing defaults. Each is overridable by a CLI flag (see options.ts);
// these are the fallbacks used when the flag is absent.
const DEFAULT_HEARTBEAT_MS = 8000;
const DEFAULT_HEARTBEAT_QUIET_MS = 6000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2500;
const DEFAULT_PTY_WRITE_DELAY_MS = 300;

// Readiness gate: we wait for the composer box-border '╭' to appear in the PTY
// stream (proof the TUI can accept pasted input) plus a short quiescence window
// before writing the prompt, so the CR is never swallowed. If the marker never
// shows we fall back after this bound — same blind delay as the old fixed wait.
const COMPOSER_READY_MARKER = "╭";
const DEFAULT_READINESS_FALLBACK_MS = 2500;
const DEFAULT_READINESS_SETTLE_MS = 250;
// If the boot prompt is not acknowledged (no hook / no JSONL) within this
// window, we declare it lost so the daemon stops showing a false WORKING. Must
// exceed heartbeatQuietMs + heartbeatMs so a healthy slow worker is not flagged.
const DEFAULT_PROMPT_ACK_WINDOW_MS = 15000;
// Grace between SIGTERM and SIGKILL of the claude PTY child during cleanup.
const PTY_SIGKILL_DELAY_MS = 1500;
// Long-poll timeout for the question hook → daemon round-trip. Must stay
// coordinated with the daemon policy ttlMs and gateway abort timeout.
const POLICY_LONG_POLL_TIMEOUT_MS =
  Number.parseInt(process.env.CLAUDE_MGR_POLICY_TIMEOUT_MS ?? "", 10) || 3_600_000;

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
const agentToolUseIdCache = new Map<string, string>();

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

const writeQueue = new PtyWriteQueue(
  pty,
  (err) => {
    console.error(`[${name}] pty write error: ${err instanceof Error ? err.message : err}`);
  },
  opts.ptyWriteDelayMs ?? DEFAULT_PTY_WRITE_DELAY_MS,
);

// Lifecycle ----------------------------------------------------------------

const shutdown = createShutdownScheduler({
  graceMs: opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
  state,
  killPty: (): void => { try { pty.kill(); } catch {} },
  name,
});

const heartbeat = startHeartbeat({
  intervalMs: opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
  quietThresholdMs: opts.heartbeatQuietMs ?? DEFAULT_HEARTBEAT_QUIET_MS,
  state,
  emit: (t, p) => evt.emit(t, p),
});

// Boot gate + prompt delivery ---------------------------------------------

const ack = createPromptAckWatchdog({
  ackWindowMs: opts.promptAckWindowMs ?? DEFAULT_PROMPT_ACK_WINDOW_MS,
  now: () => Date.now(),
  onUnacknowledged: (elapsedMs): void => {
    // No hook and no JSONL ever arrived: the prompt was almost certainly
    // swallowed. Zero lastUserMsgTs so the heartbeat stops emitting — otherwise
    // it would flip the worker back to WORKING and re-hide the loss. The daemon
    // turns prompt_unacknowledged into IDLE(prompt_lost); a genuinely
    // slow-but-alive worker self-heals when its first real JSONL lands.
    state.lastUserMsgTs = 0;
    evt.emit("lifecycle", { phase: "prompt_unacknowledged", elapsedMs });
  },
});
if (
  (opts.promptAckWindowMs ?? DEFAULT_PROMPT_ACK_WINDOW_MS) <=
  (opts.heartbeatQuietMs ?? DEFAULT_HEARTBEAT_QUIET_MS) +
    (opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS)
) {
  console.warn(`[${name}] prompt-ack-window-ms should exceed heartbeat-quiet-ms + heartbeat-ms`);
}

// Pre-boot writes get eaten by the TUI, so we buffer them until the readiness
// gate confirms the composer can accept input, then flush + write the prompt.
let bootBuffer: string[] = [];
let bootCompleted = false;

function onBootReady(reason: "marker" | "fallback"): void {
  const hadBufferedMsg = bootBuffer.length > 0;
  bootCompleted = true;
  for (const t of bootBuffer) writeQueue.enqueue(t);
  bootBuffer = [];

  // A user message that arrived during boot supersedes the initial prompt.
  if (opts.prompt && opts.prompt.trim().length > 0 && !hadBufferedMsg) {
    if (reason === "fallback") evt.emit("lifecycle", { phase: "ready_timeout" });
    console.log(`\n[${name}] writing prompt`);
    evt.emit("lifecycle", { phase: "prompt_sent" });
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    writeQueue.enqueue(opts.prompt);
    ack.arm();
  } else {
    evt.emit("lifecycle", { phase: "ready_no_prompt" });
    if (state.lastUserMsgTs === 0) {
      evt.emit("state", { state: "IDLE" });
    }
  }
}

const readiness = createReadinessGate({
  marker: COMPOSER_READY_MARKER,
  fallbackMs: opts.readinessFallbackMs ?? DEFAULT_READINESS_FALLBACK_MS,
  settleMs: opts.readinessSettleMs ?? DEFAULT_READINESS_SETTLE_MS,
  onReady: onBootReady,
});
pty.onData((data: string) => {
  process.stdout.write(data);
  readiness.feed(data);
});

// Ingest server (message + hook) ------------------------------------------

function dispatchToPty(text: string): void {
  if (bootCompleted) writeQueue.enqueue(text);
  else bootBuffer.push(text);
}

const ingest = startIngestServer(opts.port, {
  onMessage(text): void {
    shutdown.cancel();
    ack.cancel();
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    evt.emit("lifecycle", { phase: "message_received", text: text.slice(0, 200) });
    dispatchToPty(text);
  },
  onKeystroke(keys): void {
    state.lastJsonlActivityTs = Date.now();
    pty.write(keys);
  },
  async onQuestionHook(body) {
    if (!opts.daemonUrl || !opts.workerId) return null;
    const toolInput = body.tool_input as Record<string, unknown> | undefined;
    const questions = toolInput?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return null;

    const url = `${opts.daemonUrl}/workers/${opts.workerId}/question`;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions, toolUseId: body.tool_use_id }),
        signal: AbortSignal.timeout(POLICY_LONG_POLL_TIMEOUT_MS),
      });
      if (!r.ok) return null;
      const data = await r.json() as { answers?: Record<string, string> };
      return data.answers ? { answers: data.answers } : null;
    } catch {
      return null;
    }
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
      // First hook carrying a session id is the earliest proof claude received
      // the prompt and started the turn (precedes the first JSONL line).
      ack.acknowledge();
      state.sessionId = body.session_id;
      console.log(`[${name}] captured session=${state.sessionId} via ${eventName}`);
      tailHandle = startJsonlTail({
        cwd: wt.cwd,
        sessionId: state.sessionId,
        defaultModel: opts.model,
        name,
        onEvent: (t, p) => evt.emit(t, p),
        onActivity: (): void => { state.lastJsonlActivityTs = Date.now(); ack.acknowledge(); },
      });
    }
    // Subagent inner-tool hooks carry agent_id; resolve it to the parent Agent
    // tool_use id so the UI attributes the tool deterministically. Parent-level
    // hooks have no agent_id, so the field stays absent (back-compatible).
    const agentId = typeof body.agent_id === "string" ? body.agent_id : null;
    let parentAgentToolUseId: string | null = null;
    if (agentId && state.sessionId) {
      parentAgentToolUseId =
        agentToolUseIdCache.get(agentId) ??
        resolveParentAgentToolUseId(wt.cwd, state.sessionId, agentId);
      if (parentAgentToolUseId) agentToolUseIdCache.set(agentId, parentAgentToolUseId);
    }
    if (eventName === "PreToolUse") {
      evt.emit("tool_running", {
        toolName: body.tool_name ?? "unknown",
        toolUseId: body.tool_use_id ?? null,
        input: body.tool_input ?? {},
        ...(parentAgentToolUseId ? { parentAgentToolUseId } : {}),
      });
    }
    if (eventName === "PostToolUse") {
      evt.emit("tool_done", {
        toolName: body.tool_name ?? "unknown",
        toolUseId: body.tool_use_id ?? null,
        result: extractToolResponse(body.tool_response ?? body.tool_result ?? ""),
        ...(parentAgentToolUseId ? { parentAgentToolUseId } : {}),
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
  cleanup(exitCode ?? WORKER_EXIT.SUCCESS);
});

function cleanup(code: number): void {
  if (state.cleanedUp) return;
  state.cleanedUp = true;
  heartbeat.stop();
  shutdown.cancel();
  readiness.cancel();
  ack.cancel();
  if (tailHandle) { tailHandle.close(); tailHandle = null; }
  // Make absolutely sure the claude PTY child is signalled — process.exit
  // alone closes the master FD but a timing race can leave orphan claude
  // processes.
  try { pty.kill("SIGTERM"); } catch {}
  const killTimer = setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} }, PTY_SIGKILL_DELAY_MS);
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

function extractToolResponse(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((b) => extractToolResponse(b)).join("");
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const file = obj.file as Record<string, unknown> | undefined;
    if (file && typeof file.content === "string") return file.content;
    if (typeof obj.text === "string") return obj.text;
    if (typeof obj.content === "string") return obj.content;
  }
  return "";
}

process.on("SIGINT", () => cleanup(WORKER_EXIT.INTERRUPTED));
process.on("SIGTERM", () => cleanup(WORKER_EXIT.KILLED));

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
