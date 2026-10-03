import { randomUUID } from "node:crypto";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import { spawnPtyHost, type PtyHost, type SpawnPtyHost } from "../../spawner/pty-host.ts";
import type { PtyKind, PtyPending, PtySession } from "../../contracts/src/http.ts";
import { claudeLaunch, createOscScanner } from "./pty/claudeLaunch.ts";
import { stepGapMs } from "./pty/claudeKeys.ts";
import { createScreenMirror, type ScreenMirror } from "./pty/screenMirror.ts";
import { OrderedInput } from "./pty/orderedInput.ts";

// Interactive multi-tab PTY sessions (the `pty` feature). Each session is a
// long-lived login shell in a real PTY. Output is BATCHED onto the bus as
// pty:data (LEADING-EDGE: the first bytes of a window publish immediately so
// the prompt/echo paints with ~0 added latency, then a ~16ms / 8KB trailing
// batch coalesces sustained bursts). The window is one frame at 60fps, not the
// 200ms of the one-shot TerminalRunService idiom: interactive echo lands inside
// the window on every keystroke, so 200ms there felt rubber-banded. The 8KB
// trigger still caps a full-throughput dump. Output mirrors into a per-session
// headless terminal (pty/screenMirror) whose screen snapshot
// GET /pty/:id/buffer replays on reattach; the client dedups live frames with
// seq <= the snapshot's seq. Distinct from TerminalRunService, the one-shot `!`
// runner — see the naming note in contracts/src/http.ts.
// A session's metadata (kind, size, Claude conversation id, title) is published
// as pty:session on create and whenever it changes.

interface Session {
  id: string;
  number: number;
  host: PtyHost;
  cwd: string;
  cols: number;
  rows: number;
  alive: boolean;
  kind: PtyKind;
  claudeSessionId: string | null;
  title: string | null;
  remote: boolean;
  owner: string | null;
  // The last dialog tool call Claude reported (PreToolUse hook) and when.
  dialog: (PtyPending & { at: number }) | null;
  scanOsc: ReturnType<typeof createOscScanner>;
  // Serializes multi-step input (sendSteps) so two sequences never interleave.
  inputChain: Promise<unknown>;
  // Fed ONLY flushed (published) output, so a snapshot always corresponds
  // exactly to `seq` — a reattach replay can never double-render a batch that
  // is still pending.
  screen: ScreenMirror;
  seq: number;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

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
  private readonly orderedInput = new OrderedInput();
  private bus: EventBus;
  private spawn: SpawnPtyHost;
  private defaultCwd: string;
  private sleep: (ms: number) => Promise<void>;
  // Env for a claude session; unset → the host's default env.
  private claudeEnv?: () => Record<string, string | undefined>;

  constructor(deps: {
    bus: EventBus; defaultCwd: string; spawn?: SpawnPtyHost; sleep?: (ms: number) => Promise<void>;
    claudeEnv?: () => Record<string, string | undefined>;
  }) {
    this.bus = deps.bus;
    this.defaultCwd = deps.defaultCwd;
    this.spawn = deps.spawn ?? spawnPtyHost;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.claudeEnv = deps.claudeEnv;
  }

  create(input: {
    cols: number; rows: number; cwd?: string; command?: string;
    claude?: { resume?: string }; remote?: boolean; owner?: string;
  }): PtySession {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new PtyCapError(`too many terminal sessions (max ${MAX_SESSIONS})`);
    }
    const id = randomUUID();
    const number = this.nextNumber++;
    const cwd = input.cwd ?? this.defaultCwd;
    const claude = input.claude ? claudeLaunch(input.claude.resume) : null;
    const command = claude?.command ?? input.command;
    const env = claude ? this.claudeEnv?.() : undefined;
    const host = this.spawn({ cwd, cols: input.cols, rows: input.rows, command, env });
    const session: Session = {
      id, number, host, cwd, cols: input.cols, rows: input.rows, alive: true,
      kind: claude ? "claude" : "shell", claudeSessionId: claude?.claudeSessionId ?? null,
      title: null, remote: input.remote === true, owner: input.owner ?? null, dialog: null, scanOsc: createOscScanner(), inputChain: Promise.resolve(),
      screen: createScreenMirror(input.cols, input.rows), seq: 0, pending: "", flushTimer: null,
    };
    this.sessions.set(id, session);
    host.onData((data) => this.onData(id, data));
    host.onExit((exitCode) => this.onExit(id, exitCode));
    const pub = toPublic(session);
    this.bus.publish("pty:session", pub);
    return pub;
  }

  list(): PtySession[] {
    return [...this.sessions.values()].map(toPublic);
  }

  get(id: string): PtySession | null {
    const s = this.sessions.get(id);
    return s ? toPublic(s) : null;
  }

  input(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return false;
    s.host.write(data);
    return true;
  }

  // One client input stream's chunk, written in `seq` order (OrderedInput).
  inputInOrder(id: string, stream: string, seq: number, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return false;
    this.orderedInput.accept(`${id}\0${stream}`, seq, data, (d) => { this.input(id, d); });
    return true;
  }

  dialogCall(id: string): (PtyPending & { at: number }) | null {
    return this.sessions.get(id)?.dialog ?? null;
  }

  foreground(id: string): string | null {
    const s = this.sessions.get(id);
    return s?.alive ? s.host.foreground() : null;
  }

  // Writes each step on its own with a pause after it (a TUI reads keys that
  // arrive together as one paste). Resolves false if the session is gone.
  sendSteps(id: string, steps: string[]): Promise<boolean> {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return Promise.resolve(false);
    const run = s.inputChain.then(async () => {
      for (const step of steps) {
        if (!s.alive) return false;
        s.host.write(step);
        await this.sleep(stepGapMs(step));
      }
      return true;
    });
    s.inputChain = run.catch(() => {});
    return run;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return false;
    const changed = s.cols !== cols || s.rows !== rows;
    s.cols = cols;
    s.rows = rows;
    s.host.resize(cols, rows);
    s.screen.resize(cols, rows);
    // A mirroring device draws at the PTY's grid.
    if (changed) this.bus.publish("pty:session", toPublic(s));
    return true;
  }

  async buffer(id: string): Promise<{ seq: number; data: string } | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const seq = s.seq;
    return { seq, data: await s.screen.snapshot() };
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
    this.applyOsc(s, data);
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

  private applyOsc(s: Session, data: string): void {
    let changed = false;
    for (const ev of s.scanOsc(data)) {
      if (ev.kind === "title" && ev.title !== s.title) { s.title = ev.title; changed = true; }
      if (ev.kind === "claudeSession" && ev.id !== s.claudeSessionId) { s.claudeSessionId = ev.id; changed = true; }
      if (ev.kind === "dialogTool") {
        s.dialog = { ...ev.call, at: Date.now() };
        this.bus.publish("pty:conversation", { sessionId: s.id, claudeSessionId: s.claudeSessionId });
      }
    }
    if (changed) this.bus.publish("pty:session", toPublic(s));
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
    s.screen.write(data);
    this.bus.publish("pty:data", { sessionId: s.id, number: s.number, seq: s.seq, data });
  }

  private onExit(id: string, exitCode: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    this.publishPending(s); // drain trailing output ahead of the exit frame
    s.alive = false;
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
    s.screen.dispose();
    this.sessions.delete(id);
    // Registry emptied → reopen numbering from 1 (see nextNumber above).
    if (this.sessions.size === 0) this.nextNumber = 1;
    this.bus.publish("pty:exit", { sessionId: id, number: s.number, exitCode });
  }
}

function toPublic(s: Session): PtySession {
  return {
    sessionId: s.id, number: s.number, cwd: s.cwd, cols: s.cols, rows: s.rows, alive: s.alive,
    kind: s.kind, claudeSessionId: s.claudeSessionId, title: s.title, remote: s.remote, owner: s.owner,
  };
}
