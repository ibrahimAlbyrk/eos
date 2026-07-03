import { randomUUID } from "node:crypto";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { spawnPtyHost, type PtyHost, type SpawnPtyHost } from "../../spawner/pty-host.ts";
import type { PtySession } from "../../contracts/src/http.ts";

// Interactive multi-tab PTY sessions (the `pty` feature). Each session is a
// long-lived login shell in a real PTY. Output is BATCHED onto the bus as
// pty:data (LEADING-EDGE: the first bytes of a window publish immediately so
// the prompt/echo paints with ~0 added latency, then a ~16ms / 8KB trailing
// batch coalesces sustained bursts). The window is one frame at 60fps, not the
// 200ms of the one-shot TerminalRunService idiom: interactive echo lands inside
// the window on every keystroke, so 200ms there felt rubber-banded. The 8KB
// trigger still caps a full-throughput dump. Output mirrors into a per-session
// rolling ring buffer that
// GET /pty/:id/buffer replays on reattach; the client dedups live frames with
// seq <= its last-seen seq. Distinct from TerminalRunService, the one-shot `!`
// runner — see the naming note in contracts/src/http.ts.

interface Session {
  id: string;
  number: number;
  host: PtyHost;
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  // Ring buffer holds ONLY flushed (published) output, so its content always
  // corresponds exactly to `seq` — a reattach replay can never double-render a
  // batch that is still pending.
  buffer: string;
  seq: number;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const BUFFER_CAP = 256 * 1024;
// Trailing-batch window: ~one frame at 60fps. Bounds added echo latency to
// <=~16ms during sustained typing while still coalescing bursts; the 8KB
// trigger below handles throughput floods (cat bigfile) without waiting.
const FLUSH_MS = 16;
const FLUSH_BYTES = 8 * 1024;
const MAX_SESSIONS = 32;

// create() beyond the cap throws this so the route maps it to a 4xx.
export class PtyCapError extends Error {}

export class PtySessionService {
  private sessions = new Map<string, Session>();
  // Tab counter: monotonic (never reused) WHILE any session is open, so two
  // live tabs never share a number. Resets to 1 whenever the registry empties
  // (last tab closed / shell exited) — reopening from zero tabs is "Terminal 1"
  // again, not an ever-climbing count. Also resets on daemon restart.
  private nextNumber = 1;
  private bus: EventBus;
  private spawn: SpawnPtyHost;
  private defaultCwd: string;

  constructor(deps: { bus: EventBus; defaultCwd: string; spawn?: SpawnPtyHost }) {
    this.bus = deps.bus;
    this.defaultCwd = deps.defaultCwd;
    this.spawn = deps.spawn ?? spawnPtyHost;
  }

  create(input: { cols: number; rows: number; cwd?: string }): PtySession {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new PtyCapError(`too many terminal sessions (max ${MAX_SESSIONS})`);
    }
    const id = randomUUID();
    const number = this.nextNumber++;
    const cwd = input.cwd ?? this.defaultCwd;
    const host = this.spawn({ cwd, cols: input.cols, rows: input.rows });
    const session: Session = {
      id, number, host, cwd, cols: input.cols, rows: input.rows,
      alive: true, buffer: "", seq: 0, pending: "", flushTimer: null,
    };
    this.sessions.set(id, session);
    host.onData((data) => this.onData(id, data));
    host.onExit((exitCode) => this.onExit(id, exitCode));
    return toPublic(session);
  }

  list(): PtySession[] {
    return [...this.sessions.values()].map(toPublic);
  }

  input(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return false;
    s.host.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return false;
    s.cols = cols;
    s.rows = rows;
    s.host.resize(cols, rows);
    return true;
  }

  buffer(id: string): { seq: number; data: string } | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    return { seq: s.seq, data: s.buffer };
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    // onExit does the registry cleanup + pty:exit publish. A dead-but-registered
    // host that never re-fires onExit is not expected in v1 (no idle reap).
    s.host.kill();
    return true;
  }

  private onData(id: string, data: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.pending += data;
    // A full 8KB batch flushes at once regardless of window.
    if (s.pending.length >= FLUSH_BYTES) { this.publishPending(s); this.openBatchWindow(s); return; }
    // Inside an open window: just accumulate — the trailing timer drains it.
    if (s.flushTimer) return;
    // Leading edge (no window open, nothing flushed recently): publish now so
    // the first prompt bytes hit the bus immediately, then open the window.
    this.publishPending(s);
    this.openBatchWindow(s);
  }

  // Opens (or re-opens) the ~16ms trailing-batch window. When it closes, any
  // output that accumulated during the window is drained in one frame; if none
  // did, the next byte starts a fresh leading-edge publish.
  private openBatchWindow(s: Session): void {
    if (s.flushTimer) clearTimeout(s.flushTimer);
    s.flushTimer = setTimeout(() => {
      s.flushTimer = null;
      if (s.pending) this.publishPending(s);
    }, FLUSH_MS);
  }

  private publishPending(s: Session): void {
    if (!s.pending) return;
    const data = s.pending;
    s.pending = "";
    s.seq += 1;
    s.buffer += data;
    if (s.buffer.length > BUFFER_CAP) s.buffer = s.buffer.slice(s.buffer.length - BUFFER_CAP);
    this.bus.publish("pty:data", { sessionId: s.id, number: s.number, seq: s.seq, data });
  }

  private onExit(id: string, exitCode: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.publishPending(s); // drain trailing output ahead of the exit frame
    s.alive = false;
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    this.sessions.delete(id);
    // Registry emptied → reopen numbering from 1 (see nextNumber above).
    if (this.sessions.size === 0) this.nextNumber = 1;
    this.bus.publish("pty:exit", { sessionId: id, number: s.number, exitCode });
  }
}

function toPublic(s: Session): PtySession {
  return { sessionId: s.id, number: s.number, cwd: s.cwd, cols: s.cols, rows: s.rows, alive: s.alive };
}
