import { randomUUID } from "node:crypto";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { spawnPtyHost, type PtyHost, type SpawnPtyHost } from "../../spawner/pty-host.ts";
import type { PtySession } from "../../contracts/src/http.ts";

// Interactive multi-tab PTY sessions (the `pty` feature). Each session is a
// long-lived login shell in a real PTY. Output is BATCHED onto the bus as
// pty:data (200ms / 8KB, the TerminalRunService idiom — a keystroke-echo
// firehose otherwise) and mirrored into a per-session rolling ring buffer that
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
const FLUSH_MS = 200;
const FLUSH_BYTES = 8 * 1024;
const MAX_SESSIONS = 32;

// create() beyond the cap throws this so the route maps it to a 4xx.
export class PtyCapError extends Error {}

export class PtySessionService {
  private sessions = new Map<string, Session>();
  // Monotonic tab counter — assigned at create, NEVER reused (server-owned).
  // Resets to 1 on daemon restart, when every session dies anyway.
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
    if (s.pending.length >= FLUSH_BYTES) this.flush(id);
    else if (!s.flushTimer) s.flushTimer = setTimeout(() => this.flush(id), FLUSH_MS);
  }

  private flush(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    if (!s.pending) return;
    const data = s.pending;
    s.pending = "";
    s.seq += 1;
    s.buffer += data;
    if (s.buffer.length > BUFFER_CAP) s.buffer = s.buffer.slice(s.buffer.length - BUFFER_CAP);
    this.bus.publish("pty:data", { sessionId: id, number: s.number, seq: s.seq, data });
  }

  private onExit(id: string, exitCode: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.flush(id); // drain trailing output ahead of the exit frame
    s.alive = false;
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    this.sessions.delete(id);
    this.bus.publish("pty:exit", { sessionId: id, number: s.number, exitCode });
  }
}

function toPublic(s: Session): PtySession {
  return { sessionId: s.id, number: s.number, cwd: s.cwd, cols: s.cols, rows: s.rows, alive: s.alive };
}
