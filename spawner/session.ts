// Worker session state machine — owns the timestamps + flags that drive
// heartbeat, shutdown scheduling, and cleanup re-entrancy. Stateful by
// design; mutated by event handlers in the composition root.

export interface SessionState {
  sessionId: string | null;
  lastJsonlActivityTs: number;
  lastUserMsgTs: number;
  lastTurnEndTs: number;
  pendingShutdown: boolean;
  cleanedUp: boolean;
  events: Array<{ event: string; t: number }>;
}

export function newSessionState(): SessionState {
  return {
    sessionId: null,
    lastJsonlActivityTs: 0,
    lastUserMsgTs: 0,
    lastTurnEndTs: 0,
    pendingShutdown: false,
    cleanedUp: false,
    events: [],
  };
}

// Heartbeat: while a turn is active (user message sent, no Stop hook yet)
// and Claude has produced no JSONL commit for a while (typical of long
// opus deliberation), emit a "still alive" event so the UI doesn't go
// blank. Skipped between turns (idle persistent orchestrator stays
// silent).
export interface HeartbeatOptions {
  intervalMs: number;
  quietThresholdMs: number;
  state: SessionState;
  emit(type: string, payload: unknown): void;
}

export function startHeartbeat(opts: HeartbeatOptions): { stop(): void } {
  const timer = setInterval(() => {
    if (opts.state.pendingShutdown) return;
    if (opts.state.lastUserMsgTs === 0) return;
    if (opts.state.lastUserMsgTs <= opts.state.lastTurnEndTs) return;
    const now = Date.now();
    const quietMs = now - (opts.state.lastJsonlActivityTs || opts.state.lastUserMsgTs);
    if (quietMs < opts.quietThresholdMs) return;
    opts.emit("heartbeat", {
      elapsedMs: now - opts.state.lastUserMsgTs,
      quietMs,
    });
  }, opts.intervalMs);
  return { stop(): void { clearInterval(timer); } };
}

// scheduleShutdown — schedules a PTY kill after the configured grace
// window. Cancellable: sending a new /message before the grace elapses
// clears the timer.
export interface ShutdownScheduler {
  schedule(): void;
  cancel(): void;
}

export interface ShutdownOptions {
  graceMs: number;
  state: SessionState;
  killPty(): void;
  name: string;
}

export function createShutdownScheduler(opts: ShutdownOptions): ShutdownScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(): void {
      if (opts.state.pendingShutdown) return;
      opts.state.pendingShutdown = true;
      timer = setTimeout(() => {
        console.log(`[${opts.name}] kill pty`);
        opts.killPty();
      }, opts.graceMs);
    },
    cancel(): void {
      opts.state.pendingShutdown = false;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
