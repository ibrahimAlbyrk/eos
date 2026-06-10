#!/usr/bin/env node
// Worker entrypoint — composition root only. Each concern lives in a
// neighbour module: options.ts (CLI parsing), events.ts (ordered daemon RPC),
// worktree.ts (git lifecycle), settings.ts (claude settings.json),
// claude-args.ts (argv composition), delivery.ts (verified serialized PTY
// delivery), tail.ts (JSONL chokidar), ingest.ts (local HTTP), session.ts
// (state + heartbeat + shutdown scheduling).

import { rmSync, readFileSync } from "node:fs";
import { spawn as ptySpawn } from "@homebridge/node-pty-prebuilt-multiarch";

import { WORKER_EXIT } from "../contracts/src/util.ts";
import { parseWorkerOptions } from "./options.ts";
import { createDaemonEventClient } from "./events.ts";
import { setupWorktree, teardownWorktree } from "./worktree.ts";
import { buildClaudeSettings } from "./settings.ts";
import { buildClaudeArgs } from "./claude-args.ts";
import { buildSystemPromptFile } from "./prompt-context.ts";
import { DeliveryPipeline } from "./delivery.ts";
import { startJsonlTail, findClearedSessionJsonl, type TailHandle } from "./tail.ts";
import { startIngestServer } from "./ingest.ts";
import {
  newSessionState,
  startHeartbeat,
  createShutdownScheduler,
} from "./session.ts";
import { createReadinessGate } from "./readiness-gate.ts";
import { resolveParentAgentToolUseId } from "./subagent-meta.ts";
import { RewindDriver, type RewindMode } from "./rewind.ts";
import { AnswerDriver, type AnswerSpec } from "./answer-driver.ts";
import { PendingMessageRegistry, type PendingMessage } from "./message-registry.ts";

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
// Grace between SIGTERM and SIGKILL of the claude PTY child during cleanup.
const PTY_SIGKILL_DELAY_MS = 1500;
// Long-poll timeout for the question hook → daemon round-trip. Must stay
// coordinated with the daemon policy ttlMs and gateway abort timeout.
const POLICY_LONG_POLL_TIMEOUT_MS =
  Number.parseInt(process.env.EOS_POLICY_TIMEOUT_MS ?? "", 10) || 3_600_000;

const opts = parseWorkerOptions();
const name = opts.name ?? "w" + Math.random().toString(36).slice(2, 7);

const evt = createDaemonEventClient(opts.daemonUrl, opts.workerId);
const wt = setupWorktree({
  worktreeFrom: opts.worktreeFrom,
  cwd: opts.cwd,
  name,
  branch: opts.branch,
  worktreeDir: opts.worktreeDir,
  attach: opts.worktreeAttach,
  hydrateEnv: opts.hydrateEnv,
}, (m) => console.log(`[${name}] ${m}`));

const settings = buildClaudeSettings(name, opts.port);
const systemPromptFile = buildSystemPromptFile({
  staticPromptFile: opts.systemPromptFile,
  wt,
  tmpDir: settings.tmpDir,
  name,
  workerId: opts.workerId,
});
const claudeArgs = buildClaudeArgs({ ...opts, systemPromptFile }, settings.tmpDir, settings.settingsPath, {
  daemonUrl: opts.daemonUrl,
  workerId: opts.workerId,
});

console.log(`[${name}] cwd=${wt.cwd} port=${opts.port} settings=${settings.settingsPath}`);

const state = newSessionState();
let tailHandle: TailHandle | null = null;
const agentToolUseIdCache = new Map<string, string>();

// Resume: the session id is known up front — seed it and tail from EOF so the
// prior conversation already in the transcript is not replayed into the daemon
// (duplicate chat events + double-counted usage). If claude forks to a new id
// instead, the first hook mismatch swaps tails; that first swap also starts at
// EOF (the forked file carries the copied history). A matching hook confirms
// the id was kept and disarms the one-shot so later /clear swaps read from 0.
let resumeSwapEofPending = !!opts.resumeSessionId;
if (opts.resumeSessionId) {
  state.sessionId = opts.resumeSessionId;
  tailHandle = startTail(opts.resumeSessionId, true);
  console.log(`[${name}] resuming session=${opts.resumeSessionId}`);
}

// PTY ----------------------------------------------------------------------

const claudeBin = process.env.EOS_CLAUDE_BIN || "claude";
console.log(`[${name}] spawn: claude ${claudeArgs.args.join(" ")}`);
evt.emit("lifecycle", {
  phase: "claude_spawning",
  args: claudeArgs.args,
  cwd: wt.cwd,
  worktreeDir: wt.worktreeDir,
  branch: wt.branch,
  forkBaseSha: wt.forkBaseSha,
  attached: wt.attached,
  ...(wt.hydration ? { hydration: wt.hydration } : {}),
});

// Claude 2.1.168+ treats a child that inherits the parent's session markers
// (CLAUDECODE / CLAUDE_CODE_*) as a NESTED session: it skips top-level
// interactive registration and never persists the conversation transcript —
// only the ai-title stub lands on disk. That silently starves the JSONL tail
// (no assistant_text → blank chat). Strip them so each worker boots as its own
// top-level interactive Claude session. (The daemon itself is often launched
// from inside a Claude Code session, so these leak in via process.env.)
const cleanEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v === undefined) continue;
  if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
  cleanEnv[k] = v;
}

const pty = ptySpawn(claudeBin, claudeArgs.args, {
  cwd: wt.cwd,
  cols: 120,
  rows: 30,
  env: {
    ...cleanEnv,
    TERM: "xterm-256color",
    ...(opts.daemonUrl && opts.workerId
      ? {
          EOS_SPAWNED: "1",
          EOS_WORKER_ID: opts.workerId,
          EOS_DAEMON_URL: opts.daemonUrl,
        }
      : {}),
    // Worktree awareness: realpath'd facts so the agent (and anything it
    // spawns) can tell it is isolated. SOURCE_ROOT, not REPO_ROOT — that
    // name already means the Eos repo in the inherited env.
    ...(wt.worktreeDir && wt.branch && wt.repoRoot
      ? {
          EOS_WORKTREE_DIR: wt.worktreeDir,
          EOS_WORKTREE_BRANCH: wt.branch,
          EOS_SOURCE_ROOT: wt.repoRoot,
        }
      : {}),
    EOS_ISOLATION: wt.worktreeDir ? "worktree" : "none",
  },
});

// True from the moment we submit a message until Claude's Stop/SessionEnd (or
// an interrupt). While open, the delivery pipeline skips turn-ACK: a mid-turn
// message is queued by the TUI and reaches the transcript only when the queue
// drains, so an ACK timeout there would retry and duplicate it.
let claudeTurnOpen = false;

const pipeline = new DeliveryPipeline({
  write: (s) => pty.write(s),
  emit: (t, p) => evt.emit(t, p),
  canVerifyAck: () => tailHandle !== null,
  isTurnActive: () => claudeTurnOpen,
  onWriteError: (err) => {
    console.error(`[${name}] pty write error: ${err instanceof Error ? err.message : err}`);
  },
  fallbackCrDelayMs: opts.ptyWriteDelayMs ?? DEFAULT_PTY_WRITE_DELAY_MS,
});

// Daemon-dispatched messages waiting for their transcript sighting — the
// worker emits the user_message/orchestrator_message chat event at that
// moment so it is durably ordered after the previous turn's trailing output.
const pendingMessages = new PendingMessageRegistry();

function emitMessageEvent(p: PendingMessage): void {
  switch (p.record.as) {
    case "orchestrator_message":
      evt.emit("orchestrator_message", {
        text: p.text,
        fromParent: p.record.fromParent,
        parentName: p.record.parentName ?? p.record.fromParent,
      });
      return;
    case "worker_report":
      // displayText = the report body without the routing wrapper the parent's
      // PTY received ("[worker x] reported…") — what the chat renders.
      evt.emit("worker_report", {
        text: p.record.displayText ?? p.text,
        fromWorker: p.record.fromWorker,
        workerName: p.record.workerName ?? p.record.fromWorker,
      });
      return;
    case "user_message":
      evt.emit("user_message", { text: p.record.displayText ?? p.text });
  }
}

function deliver(text: string): void {
  const startedTs = Date.now();
  void pipeline.enqueue(text).then((res) => {
    if (res.outcome === "failed") {
      // No turn started — stop the heartbeat from faking liveness so the
      // daemon-side delivery_failed IDLE heal sticks.
      state.lastTurnEndTs = Date.now();
      // The text never reached Claude — no chat event; the daemon-side
      // delivery_failed line is the user-visible signal.
      pendingMessages.consumeByText(text);
    } else if (state.lastTurnEndTs < startedTs) {
      // Skip when the turn already ended mid-delivery (a one-shot command like
      // /clear fires SessionEnd before the ACK resolves) — setting the flag
      // then would leave it stuck open with no Stop ever coming.
      claudeTurnOpen = true;
    }
    if (res.outcome === "unverified") {
      // No transcript sighting, but the text provably reached the composer —
      // record it now rather than risk a silently missing chat message.
      const p = pendingMessages.consumeByText(text);
      if (p) emitMessageEvent(p);
    }
    // "delivered" → already consumed by the tail's user_text match.
    // "sent" (mid-turn steer) → stays pending until Claude consumes it.
  });
}

// Rewind choreography (rewind.ts) — mutually exclusive with delivery: a paste
// landing while the panel is open would feed the panel's list, and a CR would
// execute whatever row is highlighted. Messages arriving mid-rewind are
// buffered and flushed when the choreography ends.
const rewindDriver = new RewindDriver({
  write: (s) => pty.write(s),
  readTranscript: (): string | null => {
    if (!tailHandle) return null;
    try { return readFileSync(tailHandle.path, "utf8"); } catch { return null; }
  },
  isBusy: () => claudeTurnOpen || pipeline.busy,
  log: (m) => console.log(`[${name}][rewind] ${m}`),
});

// A parked-writes buffer for one delivery gate: holds writes while the gate is
// active and replays them, in arrival order, when flushed. The invariant every
// hold must honor — there is always a path that flushes it. An unflushed hold
// silently swallows the user's messages (the bug this guards against).
class HoldBuffer {
  private held: string[] = [];
  private readonly isActive: () => boolean;
  constructor(isActive: () => boolean) { this.isActive = isActive; }
  get active(): boolean { return this.isActive(); }
  hold(text: string): void { this.held.push(text); }
  flush(sink: (_text: string) => void): void {
    const pending = this.held;
    this.held = [];
    for (const t of pending) sink(t);
  }
}

const rewindHold = new HoldBuffer(() => rewindDriver.active);

// AnswerDriver — answers Claude's native AskUserQuestion menu with verified
// keystrokes (replaces the old web-side interrupt+message path whose Esc made
// the agent see a "rejected" result). Mutually exclusive with delivery: while a
// menu is open, messages are held so no paste/CR/Esc lands on it.
let lastToolResultTs = 0;
const answerDriver = new AnswerDriver({
  write: (s) => pty.write(s),
  lastToolResultTs: () => lastToolResultTs,
  log: (m) => console.log(`[${name}][answer] ${m}`),
});
const answerHold = new HoldBuffer(() => answerDriver.menuOpen);

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

// Pre-boot writes get eaten by the TUI, so we buffer them until the readiness
// gate confirms the composer can accept input, then flush + write the prompt.
let bootBuffer: string[] = [];
let bootCompleted = false;

function onBootReady(reason: "marker" | "fallback"): void {
  const hadBufferedMsg = bootBuffer.length > 0;
  bootCompleted = true;
  for (const t of bootBuffer) deliver(t);
  bootBuffer = [];

  // A user message that arrived during boot supersedes the initial prompt.
  if (opts.prompt && opts.prompt.trim().length > 0 && !hadBufferedMsg) {
    if (reason === "fallback") evt.emit("lifecycle", { phase: "ready_timeout" });
    console.log(`\n[${name}] writing prompt`);
    evt.emit("lifecycle", { phase: "prompt_sent" });
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    deliver(opts.prompt);
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
  pipeline.feedOutput(data);
  rewindDriver.feed(data);
  answerDriver.feed(data);
});

// Ingest server (message + hook) ------------------------------------------

function dispatchToPty(text: string): void {
  // Each gate parks the write until it releases. Boot is special — its flush
  // (onBootReady) also writes the initial prompt. An open rewind panel / AUQ
  // menu owns the PTY: a paste/CR would feed it and an Esc would cancel it.
  if (!bootCompleted) { bootBuffer.push(text); return; }
  if (rewindHold.active) { rewindHold.hold(text); return; }
  if (answerHold.active) { answerHold.hold(text); return; }
  deliver(text);
}

function startTail(sessionId: string, startAtEof = false): TailHandle {
  return startJsonlTail({
    cwd: wt.cwd,
    sessionId,
    defaultModel: opts.model,
    name,
    startAtEof,
    onEvent: (t, p) => {
      // user_text doubles as the delivery turn-ACK and as the transcript
      // sighting that releases the message's chat event: emitting it HERE —
      // through the same FIFO queue as the surrounding jsonl — pins the
      // user/orchestrator message into true conversation order. The raw
      // user_text itself is still never forwarded.
      if (t === "jsonl" && (p as { kind?: string }).kind === "user_text") {
        const text = (p as { text?: string }).text ?? "";
        pipeline.notifyUserText(text, Date.now());
        for (const m of pendingMessages.consumeMatching(text)) emitMessageEvent(m);
        return;
      }
      // A tool_result while a menu is being driven is the AUQ answer landing —
      // the AnswerDriver waits on this timestamp to confirm delivery.
      if (t === "jsonl" && (p as { kind?: string }).kind === "tool_result") {
        lastToolResultTs = Date.now();
        // Self-heal: a tool_result after a menu opened means the question
        // resolved (answered out-of-band or cancelled). Release held messages
        // even when no /answer drove the close, so the menu hold can never
        // permanently wedge delivery. Skip while answer() is driving — it owns
        // the close()+flush itself.
        if (answerDriver.menuOpen && !answerDriver.active) {
          answerDriver.close();
          flushAnswerBuffer();
        }
      }
      evt.emit(t, p);
    },
    onActivity: (): void => { state.lastJsonlActivityTs = Date.now(); },
  });
}

// /clear rolls the session: new id, NEW transcript file — without a retarget
// the whole post-clear conversation is invisible to the daemon.
function swapSession(newSessionId: string, via: string): void {
  if (state.sessionId === newSessionId) return;
  console.log(`[${name}] session changed ${state.sessionId} → ${newSessionId} (via ${via})`);
  state.sessionId = newSessionId;
  evt.emit("lifecycle", { phase: "session_captured", sessionId: newSessionId, via });
  agentToolUseIdCache.clear();
  tailHandle?.close();
  tailHandle = startTail(newSessionId, resumeSwapEofPending);
  resumeSwapEofPending = false;
}

// Claude's http SessionStart hook never fires, so after SessionEnd(clear) the
// new session id must be discovered from disk: poll briefly for the new
// transcript file. A hook from the new session arriving later (session_id
// mismatch in onHook) is the self-healing fallback if the poll misses.
const CLEAR_SWAP_POLL_MS = 150;
const CLEAR_SWAP_DEADLINE_MS = 6000;
let clearSwapTimer: ReturnType<typeof setInterval> | null = null;
function watchForClearedSession(oldSessionId: string, clearTs: number): void {
  if (clearSwapTimer) clearInterval(clearSwapTimer);
  const deadline = Date.now() + CLEAR_SWAP_DEADLINE_MS;
  clearSwapTimer = setInterval(() => {
    const found = findClearedSessionJsonl(wt.cwd, oldSessionId, clearTs - 2000);
    if (found) {
      clearInterval(clearSwapTimer!);
      clearSwapTimer = null;
      swapSession(found, "clear-poll");
    } else if (Date.now() > deadline) {
      clearInterval(clearSwapTimer!);
      clearSwapTimer = null;
      console.log(`[${name}] cleared-session poll timed out — will heal on next hook`);
    }
  }, CLEAR_SWAP_POLL_MS);
}

function flushAnswerBuffer(): void { answerHold.flush(dispatchToPty); }

const ingest = startIngestServer(opts.port, {
  onMessage(text, record): void {
    shutdown.cancel();
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    evt.emit("lifecycle", { phase: "message_received", text: text.slice(0, 200) });
    // Cap-evicted entries lost their chance at a transcript sighting — emit
    // them now (early-ordered beats silently missing).
    if (record) {
      for (const m of pendingMessages.register(text, record)) emitMessageEvent(m);
    }
    dispatchToPty(text);
  },
  async onAnswer(selections): Promise<{ ok: boolean; outcome: string }> {
    shutdown.cancel();
    state.lastJsonlActivityTs = Date.now();
    try {
      // Selections present ⇒ drive the native menu with verified keystrokes.
      // Empty ⇒ the user skipped/dismissed: cancel the menu so the agent unblocks.
      let outcome: string;
      if (Array.isArray(selections) && selections.length > 0) {
        outcome = await answerDriver.answer(selections as AnswerSpec[]);
      } else {
        answerDriver.cancel();
        outcome = "dismissed";
      }
      return { ok: outcome !== "no_menu", outcome };
    } finally {
      // Always release: a turn re-opens once the menu is resolved; messages held
      // during it flush after, in arrival order — even if the drive threw.
      flushAnswerBuffer();
    }
  },
  onKeystroke(keys): void {
    // A stray keystroke mid-choreography would derail the panel navigation.
    if (rewindDriver.active) {
      console.log(`[${name}] keystroke dropped (rewind in progress)`);
      return;
    }
    state.lastJsonlActivityTs = Date.now();
    pty.write(keys);
  },
  onRewindTargets(): unknown {
    return { targets: rewindDriver.targets() };
  },
  async onRewind(body): Promise<unknown> {
    if (!bootCompleted) return { ok: false, error: "worker still booting" };
    if (typeof body.uuid !== "string" || body.uuid === "") return { ok: false, error: "uuid required" };
    const mode: RewindMode =
      body.mode === "code" || body.mode === "both" ? body.mode : "conversation";
    shutdown.cancel();
    const result = await rewindDriver.rewind(body.uuid, mode);
    // Messages that arrived mid-choreography were held back — flush them now.
    rewindHold.flush(deliver);
    return result;
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
    claudeTurnOpen = false;
    // Emit whatever transcript already landed before the abort marker so the
    // daemon sees it ahead of the turn-aborted event.
    tailHandle?.drainNow();
    // Steers the Esc tossed back to the composer will never get a transcript
    // sighting — record them now so the chat keeps showing what was sent.
    for (const m of pendingMessages.drainAll()) emitMessageEvent(m);
    evt.emit("lifecycle", { phase: "interrupted" });
    return { ok: true };
  },
  onHook(eventName, body): void {
    state.events.push({ event: eventName, t: Date.now() });
    if (!state.sessionId && typeof body.session_id === "string") {
      state.sessionId = body.session_id;
      console.log(`[${name}] captured session=${state.sessionId} via ${eventName}`);
      evt.emit("lifecycle", { phase: "session_captured", sessionId: state.sessionId, via: `hook:${eventName}` });
      tailHandle = startTail(state.sessionId);
    } else if (
      typeof body.session_id === "string" &&
      state.sessionId !== null &&
      state.sessionId !== body.session_id &&
      eventName !== "SessionEnd"
    ) {
      // A hook from a session we are not tailing — the clear-poll missed (or
      // something else rolled the session). SessionEnd excluded: it is the one
      // hook that legitimately closes the OLD session.
      swapSession(body.session_id, `hook:${eventName}`);
    } else if (resumeSwapEofPending && typeof body.session_id === "string" && body.session_id === state.sessionId) {
      // Resume kept the session id — disarm the one-shot EOF seed so a later
      // /clear swap reads its fresh transcript from offset 0.
      resumeSwapEofPending = false;
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
    // PostToolUse only fires on success; failures arrive here. Without this,
    // a failed subagent inner tool (no transcript row to pair with) would
    // never get its tool_done and shimmer as "running" forever.
    if (eventName === "PostToolUseFailure") {
      evt.emit("tool_done", {
        toolName: body.tool_name ?? "unknown",
        toolUseId: body.tool_use_id ?? null,
        result: extractToolResponse(body.tool_response ?? body.error ?? ""),
        isError: true,
        ...(parentAgentToolUseId ? { parentAgentToolUseId } : {}),
      });
    }
    if (eventName === "Stop" || eventName === "SessionEnd") {
      claudeTurnOpen = false;
      // Drain the transcript to EOF before forwarding the turn-end hook: the
      // event client is FIFO, so trailing jsonl of this turn is guaranteed to
      // reach the daemon ahead of the Stop — the settle window becomes a
      // safety net instead of the only defense.
      tailHandle?.drainNow();
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
      console.log(`[${name}][hook] SessionEnd reason=${String(body.reason ?? "")}`);
      state.lastTurnEndTs = Date.now();
      // reason "clear" = /clear rolled the session; the process lives on —
      // find the new transcript file instead of scheduling a shutdown.
      if (body.reason === "clear") {
        if (state.sessionId) watchForClearedSession(state.sessionId, Date.now());
      } else if (!opts.persistent) {
        shutdown.schedule();
      }
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
  if (clearSwapTimer) { clearInterval(clearSwapTimer); clearSwapTimer = null; }
  if (tailHandle) { tailHandle.drainNow(); tailHandle.close(); tailHandle = null; }
  // Delivered-but-unsighted messages must not vanish with the process.
  for (const m of pendingMessages.drainAll()) emitMessageEvent(m);
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
    emit: (t, p) => evt.emit(t, p),
  });

  // Give the queued events (trailing jsonl, pty_exit, worktree teardown) a
  // bounded chance to reach the daemon before the process dies.
  void evt.drain(800).finally(() => process.exit(code));
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
