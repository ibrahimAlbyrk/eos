#!/usr/bin/env node
// Worker entrypoint — composition root only. Each concern lives in a
// neighbour module: options.ts (CLI parsing), events.ts (ordered daemon RPC),
// worktree.ts (git lifecycle), settings.ts (claude settings.json),
// claude-args.ts (argv composition), delivery.ts (verified serialized PTY
// delivery), tail.ts (JSONL chokidar), ingest.ts (local HTTP), session.ts
// (state + heartbeat + shutdown scheduling).

import { rmSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as ptySpawn } from "@homebridge/node-pty-prebuilt-multiarch";

import { WORKER_EXIT, mcpReadyFlagName } from "../contracts/src/util.ts";
import { isEosControlTool, isBlockedBuiltinTool, blockedBuiltinToolMessage } from "../contracts/src/tool-scope.ts";
import { buildSubscriptionChildEnv } from "../core/src/domain/env-allowlist.ts";
import { stripSenderTags } from "../core/src/domain/sender-tag.ts";
import { parseWorkerOptions, expectsMcpReady } from "./options.ts";
import { createDaemonEventClient } from "./events.ts";
import { setupWorktree, teardownWorktree } from "./worktree.ts";
import { buildClaudeSettings } from "./settings.ts";
import { buildClaudeArgs } from "./claude-args.ts";
import { DeliveryPipeline } from "./delivery.ts";
import { startJsonlTail, findClearedSessionJsonl, type TailHandle } from "./tail.ts";
import { startIngestServer } from "./ingest.ts";
import {
  newSessionState,
  startHeartbeat,
  createShutdownScheduler,
} from "./session.ts";
import { createReadinessGate } from "./readiness-gate.ts";
import { createTerminalResponder } from "./terminal-responder.ts";
import { resolveParentAgentToolUseId } from "./subagent-meta.ts";
import { RewindDriver, type RewindMode } from "./rewind.ts";
import { PendingMessageRegistry, type PendingMessage } from "./message-registry.ts";

// Timing defaults. Each is overridable by a CLI flag (see options.ts);
// these are the fallbacks used when the flag is absent.
const DEFAULT_HEARTBEAT_MS = 8000;
const DEFAULT_HEARTBEAT_QUIET_MS = 6000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2500;
const DEFAULT_PTY_WRITE_DELAY_MS = 300;

// Readiness gate: wait until the TUI can accept pasted input, then a short
// quiescence window (initial render settled) before flushing any buffered
// steering paste. The signal is the bracketed-paste-enable control sequence
// (DECSET 2004, "\x1b[?2004h") — a STANDARD sequence every paste-aware TUI
// emits, not the cosmetic box-border glyph '╭' (theme/version/locale/width
// dependent). It appears early in boot, so the quiescence window is what
// actually waits for the composer to finish rendering. If it never shows we
// fall back after this bound. (The boot prompt no longer rides this gate — it
// goes in via an argv positional; see claude-args.ts.)
const COMPOSER_READY_MARKER = "\x1b[?2004h";
const DEFAULT_READINESS_FALLBACK_MS = 2500;
const DEFAULT_READINESS_SETTLE_MS = 250;
// mcp-ready gate: agents with an Eos tool MCP withhold the boot prompt until
// that server writes its ready flag (polled here). The fallback delivers the
// prompt anyway so a broken/slow MCP can never wedge boot — generous so it
// never preempts a working-but-slow connect (many inherited connectors).
const MCP_READY_POLL_MS = 100;
const MCP_READY_FALLBACK_MS = 15000;
// Grace between SIGTERM and SIGKILL of the claude PTY child during cleanup.
const PTY_SIGKILL_DELAY_MS = 1500;

const opts = parseWorkerOptions();
const name = opts.name ?? "w" + Math.random().toString(36).slice(2, 7);

// MCP-init race guard (see claude-args.ts / contracts mcpReadyFlagName): when an
// Eos tool MCP is present the boot prompt is withheld from argv and released
// only after that server signals ready via this flag file. Clear any stale flag
// up front so the poll reacts only to THIS session's signal.
const expectsMcp = expectsMcpReady(opts);
const mcpReadyFlagPath = opts.workerId ? join(tmpdir(), mcpReadyFlagName(opts.workerId)) : null;
if (mcpReadyFlagPath) { try { unlinkSync(mcpReadyFlagPath); } catch {} }

const evt = createDaemonEventClient(opts.daemonUrl, opts.workerId);
const wt = setupWorktree({
  worktreeFrom: opts.worktreeFrom,
  cwd: opts.cwd,
  name,
  branch: opts.branch,
  worktreeDir: opts.worktreeDir,
  attach: opts.worktreeAttach,
  hydrateEnv: opts.hydrateEnv,
  carryUncommitted: opts.carryUncommitted,
}, (m) => console.log(`[${name}] ${m}`));

const settings = buildClaudeSettings(name, opts.port);
// The system prompt is fully assembled daemon-side (DPI) and handed over as
// opts.systemPromptFile — the worker no longer reads a static file or appends a
// worktree env section here.
const claudeArgs = buildClaudeArgs(opts, settings.tmpDir, settings.settingsPath, {
  daemonUrl: opts.daemonUrl,
  workerId: opts.workerId,
});

console.log(`[${name}] cwd=${wt.cwd} port=${opts.port} settings=${settings.settingsPath}`);

const state = newSessionState();
let tailHandle: TailHandle | null = null;
// subagent agent_id → parent Agent tool_use id. Bounded (insertion-order
// eviction) so a persistent agent that spawns many distinct subagents over a
// long session can't grow it unboundedly. swapSession still .clear()s it on
// /clear — that is session-scoped correctness, separate from this size bound.
const AGENT_TOOLUSE_CACHE_MAX = 256;
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
// buildSubscriptionChildEnv also strips the subscription-diverting provider keys
// (ANTHROPIC_API_KEY / AUTH_TOKEN / BASE_URL) so a daemon-level key can never flip
// this PTY worker onto API billing (R3).
const cleanEnv = buildSubscriptionChildEnv(process.env);

const ptyOptions: Parameters<typeof ptySpawn>[2] = {
  cwd: wt.cwd,
  cols: 120,
  rows: 30,
  env: {
    ...cleanEnv,
    TERM: "xterm-256color",
    // ask_user blocks its MCP call until the operator answers — possibly days.
    // Lift the CLI's per-tool-call ceiling out of the way (ms, ~24.8 days).
    MCP_TOOL_TIMEOUT: "2147483647",
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
};

let pty: ReturnType<typeof ptySpawn>;
try {
  pty = ptySpawn(claudeBin, claudeArgs.args, ptyOptions);
} catch (e) {
  // node-pty spawns synchronously and throws if it cannot allocate a PTY (e.g.
  // EBADF/EMFILE under fd pressure). Exit non-zero so the daemon's supervisor
  // marks this worker failed (red) instead of the module crashing unhandled.
  console.error(`[${name}] failed to spawn claude PTY: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

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

function emitMessageEvent(p: PendingMessage, anchorTs?: number): void {
  // anchorTs = the consuming transcript entry's creation time — the same clock
  // domain as the surrounding assistant blocks, so the chat sorts the bubble
  // exactly where Claude consumed it (after the previous turn's trailing
  // output, before the output it caused). sentAt (dispatch wall-clock) stays
  // as the fallback for emissions with no sighting (unverified resolution,
  // interrupt/exit flush).
  const sentAt = p.record.sentAt != null ? { sentAt: p.record.sentAt } : {};
  const anchor = anchorTs != null ? { anchorTs } : {};
  switch (p.record.as) {
    case "orchestrator_message":
      // displayText = the bare directive, without the <agent_message …> wrapper
      // the model received — what this worker's chat renders.
      evt.emit("orchestrator_message", {
        text: p.record.displayText ?? p.text,
        fromParent: p.record.fromParent,
        parentName: p.record.parentName ?? p.record.fromParent,
        ...sentAt,
        ...anchor,
      });
      return;
    case "worker_report":
      // displayText = the report body without the routing wrapper the parent's
      // PTY received ("[worker x] reported…") — what the chat renders.
      evt.emit("worker_report", {
        text: p.record.displayText ?? p.text,
        fromWorker: p.record.fromWorker,
        workerName: p.record.workerName ?? p.record.fromWorker,
        ...sentAt,
        ...anchor,
      });
      return;
    case "peer_request":
      // displayText = the bare question, without the "[Peer request from x]…"
      // framing the peer's PTY received — what this peer's chat renders.
      evt.emit("peer_request", {
        text: p.record.displayText ?? p.text,
        fromWorker: p.record.fromWorker,
        fromName: p.record.fromName ?? p.record.fromWorker,
        ...sentAt,
        ...anchor,
      });
      return;
    case "loop_continuation":
      // A dynamic-loop automated re-trigger — rendered as a "Dynamic loop" system
      // message, never a user bubble.
      evt.emit("loop_continuation", {
        text: p.record.displayText ?? p.text,
        ...sentAt,
        ...anchor,
      });
      return;
    case "user_message":
      // clientMsgIds ride through so the web reconciles its optimistic
      // bubbles by id (text-prefix stays the fallback for unkeyed sends).
      evt.emit("user_message", {
        text: p.record.displayText ?? p.text,
        ...(p.record.clientMsgIds && p.record.clientMsgIds.length > 0
          ? { clientMsgIds: p.record.clientMsgIds }
          : {}),
        ...sentAt,
        ...anchor,
      });
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

// Steering messages that arrive before the TUI mounts get eaten, so we buffer
// them until boot is released (composer ready + mcp ready), then flush. The boot
// prompt rides the argv positional (claude-args.ts, auto-submitted on mount) for
// a plain agent; for one with an Eos tool MCP it is withheld from argv and pasted
// here once that server connects (the mcp-ready gate) — see tryReleaseBoot.
let bootBuffer: string[] = [];
let bootCompleted = false;
let composerReady = false;
let composerFellBack = false;
// Nothing to wait for when there is no Eos tool MCP — the prompt rode in via
// argv and the composer is the only gate.
let mcpReady = !expectsMcp;
let mcpPollTimer: ReturnType<typeof setInterval> | null = null;
let mcpFallbackTimer: ReturnType<typeof setTimeout> | null = null;

function clearMcpReadyTimers(): void {
  if (mcpPollTimer) { clearInterval(mcpPollTimer); mcpPollTimer = null; }
  if (mcpFallbackTimer) { clearTimeout(mcpFallbackTimer); mcpFallbackTimer = null; }
}

// The boot prompt is released once the composer can accept input AND (for an
// agent with an Eos tool MCP) that server has signaled ready. Two delivery
// modes: expectsMcp → the prompt was withheld from argv, so PASTE it through the
// verified pipeline now (tools are registered → no spawn_worker race); else →
// claude already auto-submitted the argv positional, so just seed turn liveness.
// Either way early steering flushes after, in arrival order.
function tryReleaseBoot(): void {
  if (bootCompleted) return;
  if (!composerReady || !mcpReady) return;
  bootCompleted = true;
  clearMcpReadyTimers();

  if (opts.prompt.trim().length > 0) {
    if (composerFellBack) evt.emit("lifecycle", { phase: "ready_timeout" });
    evt.emit("lifecycle", { phase: "prompt_sent" });
    // A turn is now active (paste about to land, or argv already submitted):
    // seed heartbeat liveness and mark the turn open so a steering message
    // arriving now is treated as a mid-turn steer (ACK skipped — no duplicate).
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    if (expectsMcp) deliver(opts.prompt);
    else claudeTurnOpen = true;
  } else {
    evt.emit("lifecycle", { phase: "ready_no_prompt" });
    if (state.lastUserMsgTs === 0) {
      evt.emit("state", { state: "IDLE" });
    }
  }

  // Early steering messages (arrived before boot release) flush now.
  for (const t of bootBuffer) deliver(t);
  bootBuffer = [];
}

function onComposerReady(reason: "marker" | "fallback"): void {
  composerReady = true;
  if (reason === "fallback") composerFellBack = true;
  tryReleaseBoot();
}

function markMcpReady(via: "signal" | "timeout"): void {
  if (mcpReady) return;
  mcpReady = true;
  clearMcpReadyTimers();
  evt.emit("lifecycle", { phase: via === "timeout" ? "mcp_ready_timeout" : "mcp_ready" });
  tryReleaseBoot();
}

// Poll for the flag the Eos tool MCP writes on connect (the spawner can't see
// claude's MCP handshake; the file is the cross-process signal), with a bounded
// fallback so a never-signaling server still boots.
if (expectsMcp && mcpReadyFlagPath) {
  mcpPollTimer = setInterval(() => {
    if (existsSync(mcpReadyFlagPath)) markMcpReady("signal");
  }, MCP_READY_POLL_MS);
  mcpFallbackTimer = setTimeout(() => markMcpReady("timeout"), MCP_READY_FALLBACK_MS);
}

const readiness = createReadinessGate({
  marker: COMPOSER_READY_MARKER,
  fallbackMs: opts.readinessFallbackMs ?? DEFAULT_READINESS_FALLBACK_MS,
  settleMs: opts.readinessSettleMs ?? DEFAULT_READINESS_SETTLE_MS,
  onReady: onComposerReady,
});
// Act as the terminal for claude's boot capability queries so its handshake
// completes deterministically (replies written raw, like keystrokes — these are
// terminal protocol bytes, not user messages).
const terminalResponder = createTerminalResponder();
pty.onData((data: string) => {
  process.stdout.write(data);
  for (const reply of terminalResponder.feed(data)) pty.write(reply);
  readiness.feed(data);
  pipeline.feedOutput(data);
  rewindDriver.feed(data);
});

// Ingest server (message + hook) ------------------------------------------

function dispatchToPty(text: string): void {
  // Each gate parks the write until it releases. Boot is special — its flush
  // (onBootReady) also writes the initial prompt. An open rewind panel owns
  // the PTY: a paste/CR would feed it and an Esc would cancel it.
  if (!bootCompleted) { bootBuffer.push(text); return; }
  if (rewindHold.active) { rewindHold.hold(text); return; }
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
        const anchorTs = (p as { tsTranscript?: number }).tsTranscript;
        pipeline.notifyUserText(text, Date.now());
        for (const m of pendingMessages.consumeMatching(text)) emitMessageEvent(m, anchorTs);
        return;
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

const ingest = startIngestServer(opts.port, {
  onMessage(text, record): void {
    shutdown.cancel();
    const now = Date.now();
    state.lastUserMsgTs = now;
    state.lastJsonlActivityTs = now;
    // Defense-in-depth: store the BARE preview, never the <agent_message>/
    // <system_message> wrapper the model received — this row is a display surface.
    evt.emit("lifecycle", { phase: "message_received", text: stripSenderTags(text).slice(0, 200) });
    // Cap-evicted entries lost their chance at a transcript sighting — emit
    // them now (early-ordered beats silently missing).
    if (record) {
      for (const m of pendingMessages.register(text, record)) emitMessageEvent(m);
    }
    dispatchToPty(text);
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
  onHook(eventName, body): Record<string, unknown> | undefined {
    state.events.push({ event: eventName, t: Date.now() });
    // Debug-only timeline (printed at exit); nothing reads it for state. Bound
    // it so a long-lived persistent agent's hook stream can't grow it forever.
    if (state.events.length > 500) state.events.shift();
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
      if (parentAgentToolUseId) {
        agentToolUseIdCache.set(agentId, parentAgentToolUseId);
        if (agentToolUseIdCache.size > AGENT_TOOLUSE_CACHE_MAX) {
          const oldest = agentToolUseIdCache.keys().next().value;
          if (oldest !== undefined) agentToolUseIdCache.delete(oldest);
        }
      }
    }
    let hookOutput: Record<string, unknown> | undefined;
    if (eventName === "PreToolUse") {
      // Denies that must live HERE: under native bypassPermissions
      // PermissionRequest never fires, while PreToolUse fires in every mode
      // and its HTTP response is honored as hook output. Two cases: blocked
      // builtins (AskUserQuestion — no answer surface in Eos) and subagents
      // driving the Eos control plane. Synthetic tool_done because a blocked
      // tool gets no PostToolUse and would stay "running".
      const toolName = typeof body.tool_name === "string" ? body.tool_name : "unknown";
      if (isBlockedBuiltinTool(toolName) || (agentId && isEosControlTool(toolName))) {
        const reason = isBlockedBuiltinTool(toolName)
          ? blockedBuiltinToolMessage(toolName)
          : `${toolName} is main-agent only — subagents cannot use Eos control tools. Return your findings; the main agent acts on them.`;
        const attribution = parentAgentToolUseId ? { parentAgentToolUseId } : {};
        evt.emit("tool_running", { toolName, toolUseId: body.tool_use_id ?? null, input: body.tool_input ?? {}, ...attribution });
        evt.emit("tool_done", { toolName, toolUseId: body.tool_use_id ?? null, result: reason, isError: true, ...attribution });
        hookOutput = {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      } else {
        evt.emit("tool_running", {
          toolName: body.tool_name ?? "unknown",
          toolUseId: body.tool_use_id ?? null,
          input: body.tool_input ?? {},
          ...(parentAgentToolUseId ? { parentAgentToolUseId } : {}),
        });
      }
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
    return hookOutput;
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
  clearMcpReadyTimers();
  if (mcpReadyFlagPath) { try { unlinkSync(mcpReadyFlagPath); } catch {} }
  if (clearSwapTimer) { clearInterval(clearSwapTimer); clearSwapTimer = null; }
  if (tailHandle) { tailHandle.drainNow(); tailHandle.close(); tailHandle = null; }
  // Delivered-but-unsighted messages must not vanish with the process.
  for (const m of pendingMessages.drainAll()) emitMessageEvent(m);
  // Signal the claude PTY child to stop. SIGTERM first (lets it exit cleanly),
  // then a GUARANTEED SIGKILL after the event drain, BEFORE process.exit. The
  // old code armed an unref'd SIGKILL timer and then exited as soon as the drain
  // resolved (usually tens of ms) — abandoning the timer and orphaning a
  // ~200-330MB claude that ignored SIGTERM / the master-FD-close SIGHUP.
  try { pty.kill("SIGTERM"); } catch {}
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

  // Hard ceiling: exit even if the drain wedges, so the process can never hang.
  // Still SIGKILL the child first — the orphan guarantee must hold on this path
  // too, not just the drain.finally path below.
  const hardExit = setTimeout(() => { try { pty.kill("SIGKILL"); } catch {} process.exit(code); }, PTY_SIGKILL_DELAY_MS + 800);
  hardExit.unref();
  // Give queued events (trailing jsonl, pty_exit, worktree teardown) a bounded
  // chance to reach the daemon, THEN guarantee the claude child is dead (SIGKILL
  // can't be ignored), THEN exit.
  void evt.drain(800).catch(() => {}).finally(() => {
    try { pty.kill("SIGKILL"); } catch {}
    process.exit(code);
  });
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
