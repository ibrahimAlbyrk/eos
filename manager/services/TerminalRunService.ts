import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Clock } from "../../core/src/ports/Clock.ts";
import type { EventBus } from "../../core/src/ports/EventBus.ts";

// User-initiated shell command runner (composer `!` terminal mode). Each run
// is an independent `bash -lc` in the worker's working dir — no PTY, no agent
// turn, no worker-state change. Output streams as batched `terminal:chunk` bus
// messages (the SSE broadcaster relays every topic); completion persists ONE
// durable `terminal` event so the chat history carries a single row per
// command instead of flooding the 500-event window with chunks.

interface EventSink {
  append(workerId: string, ts: number, type: string, payload: unknown): number;
}
interface Logger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

interface Run {
  child: ChildProcess;
  // null = workspace-scoped run (no agent selected): nothing persists, the
  // output lives only in the SSE stream + the web's in-memory store.
  workerId: string | null;
  command: string;
  cwd: string;
  startedAt: number;
  output: string;
  pending: string;
  streamedBytes: number;
  truncated: boolean;
  killNote: string | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout>;
  finished: boolean;
}

const FLUSH_MS = 200;
const FLUSH_BYTES = 8 * 1024;
const MAX_PERSIST_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const SIGKILL_GRACE_MS = 3000;

// CSI + OSC sequences. Chunk boundaries can split an escape mid-sequence —
// rare without a TTY (most tools disable color), accepted for now.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

export class TerminalRunService {
  private runs = new Map<string, Run>();
  private bus: EventBus;
  private events: EventSink;
  private clock: Clock;
  private log: Logger;

  constructor(deps: { bus: EventBus; events: EventSink; clock: Clock; log: Logger }) {
    this.bus = deps.bus;
    this.events = deps.events;
    this.clock = deps.clock;
    this.log = deps.log;
  }

  run(workerId: string | null, cwd: string, command: string): { runId: string } {
    const runId = randomUUID();
    // The user's own login shell, not bash: a foreign shell sourcing the
    // user's profile sprays "bad substitution" noise into every command.
    const shell = process.env.SHELL || "/bin/bash";
    const child = spawn(shell, ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const run: Run = {
      child, workerId, command, cwd,
      startedAt: this.clock.now(),
      output: "", pending: "", streamedBytes: 0,
      truncated: false, killNote: null, flushTimer: null,
      timeoutTimer: setTimeout(() => this.terminate(runId, "timed out after 10m"), TIMEOUT_MS),
      finished: false,
    };
    run.timeoutTimer.unref?.();
    this.runs.set(runId, run);

    child.stdout?.on("data", (b: Buffer) => this.onData(runId, b));
    child.stderr?.on("data", (b: Buffer) => this.onData(runId, b));
    child.on("error", (e) => this.finish(runId, 127, null, `bash spawn failed: ${e instanceof Error ? e.message : String(e)}`));
    child.on("close", (code, signal) => this.finish(runId, code, signal ?? null, null));
    return { runId };
  }

  kill(runId: string): boolean {
    return this.terminate(runId, "stopped by user");
  }

  private terminate(runId: string, note: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.finished) return false;
    run.killNote = note;
    try { run.child.kill("SIGTERM"); } catch { return false; }
    const hardKill = setTimeout(() => {
      if (this.runs.has(runId)) {
        try { run.child.kill("SIGKILL"); } catch {}
      }
    }, SIGKILL_GRACE_MS);
    hardKill.unref?.();
    return true;
  }

  private onData(runId: string, buf: Buffer): void {
    const run = this.runs.get(runId);
    if (!run || run.finished) return;
    const text = stripAnsi(buf.toString("utf8"));
    if (!text) return;
    run.streamedBytes += text.length;
    if (run.output.length < MAX_PERSIST_BYTES) {
      run.output += text;
      if (run.output.length > MAX_PERSIST_BYTES) {
        run.output = run.output.slice(0, MAX_PERSIST_BYTES);
        run.truncated = true;
      }
    } else {
      run.truncated = true;
    }
    run.pending += text;
    if (run.pending.length >= FLUSH_BYTES) this.flush(runId);
    else if (!run.flushTimer) {
      run.flushTimer = setTimeout(() => this.flush(runId), FLUSH_MS);
    }
    if (run.streamedBytes > MAX_STREAM_BYTES && !run.killNote) {
      this.terminate(runId, "output limit exceeded (2MB)");
    }
  }

  private flush(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
    if (!run.pending) return;
    const data = run.pending;
    run.pending = "";
    this.bus.publish("terminal:chunk", {
      workerId: run.workerId, runId, command: run.command, data,
    });
  }

  private finish(runId: string, code: number | null, signal: string | null, errNote: string | null): void {
    const run = this.runs.get(runId);
    if (!run || run.finished) return;
    run.finished = true;
    clearTimeout(run.timeoutTimer);
    this.flush(runId);
    this.runs.delete(runId);

    const exitCode = code ?? (signal ? 1 : 0);
    const note = errNote ?? run.killNote;
    const now = this.clock.now();
    if (run.workerId) {
      try {
        this.events.append(run.workerId, now, "terminal", {
          runId,
          command: run.command,
          cwd: run.cwd,
          output: run.output,
          exitCode,
          signal,
          note,
          truncated: run.truncated,
          durationMs: now - run.startedAt,
        });
      } catch (e) {
        this.log.warn("terminal event append failed", { runId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.bus.publish("terminal:done", { workerId: run.workerId, runId, exitCode, note });
    if (run.workerId) this.bus.publish("worker:change", { workerId: run.workerId });
  }
}
