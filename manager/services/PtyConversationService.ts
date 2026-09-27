import { readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import type { EventBus } from "../../core/src/ports/EventBus.ts";
import type { PtyConversationRow, PtyPending, PtySession } from "../../contracts/src/http.ts";
import { claudeTranscriptPath } from "../shared/claude-transcript-path.ts";
import { transcriptView, type TranscriptView } from "./pty/transcriptRows.ts";

// A claude pane's conversation, read from its Claude Code transcript. The file
// is watched from the first read until the pane exits or switches conversation
// (/clear, /resume); every change publishes pty:conversation so clients
// refetch. A parse is cached until the file changes. An open question or plan
// comes from the pane's own report (see claudeLaunch) when the transcript
// doesn't have it yet.

type Watch = (path: string, onChange: () => void) => () => void;

interface Sessions {
  get(id: string): PtySession | null;
  dialogCall(id: string): (PtyPending & { at: number }) | null;
}

// Polling rather than fs.watch: the file may not exist yet (no message sent),
// and a poll coalesces Claude's bursts of appends into one event.
const pollFile: Watch = (path, onChange) => {
  const listener = (cur: { mtimeMs: number; size: number }, prev: { mtimeMs: number; size: number }): void => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) onChange();
  };
  watchFile(path, { interval: 500, persistent: false }, listener);
  return () => unwatchFile(path, listener);
};

const EMPTY: TranscriptView = { rows: [], running: false, pending: null };

interface Watched {
  path: string;
  claudeSessionId: string;
  stop: () => void;
  cache: { size: number; mtimeMs: number; view: TranscriptView } | null;
}

export type PtyConversation = TranscriptView & { claudeSessionId: string | null };

export class PtyConversationService {
  private watched = new Map<string, Watched>(); // by PTY session id
  private bus: EventBus;
  private sessions: Sessions;
  private pathOf: (cwd: string, claudeSessionId: string) => string;
  private watch: Watch;

  constructor(deps: {
    bus: EventBus;
    sessions: Sessions;
    transcriptPath?: (cwd: string, claudeSessionId: string) => string;
    watch?: Watch;
  }) {
    this.bus = deps.bus;
    this.sessions = deps.sessions;
    this.pathOf = deps.transcriptPath ?? claudeTranscriptPath;
    this.watch = deps.watch ?? pollFile;
    this.bus.subscribe("pty:exit", (m) => this.forget((m.payload as { sessionId: string }).sessionId));
    this.bus.subscribe("pty:session", (m) => {
      const s = m.payload as PtySession;
      const w = this.watched.get(s.sessionId);
      if (!w || w.claudeSessionId === s.claudeSessionId) return;
      this.forget(s.sessionId);
      this.bus.publish("pty:conversation", { sessionId: s.sessionId, claudeSessionId: s.claudeSessionId });
    });
  }

  // null: no such session, or it is not a claude pane.
  get(ptyId: string): PtyConversation | null {
    const s = this.sessions.get(ptyId);
    if (!s || s.kind !== "claude") return null;
    if (!s.claudeSessionId) return { ...EMPTY, claudeSessionId: null };
    const view = this.read(this.watching(s, s.claudeSessionId));
    return { ...view, pending: view.pending ?? this.openDialog(ptyId, view.rows), claudeSessionId: s.claudeSessionId };
  }

  // The pane's reported dialog call, unless the transcript shows it settled: its
  // result, or a prompt or interrupt recorded after it opened.
  private openDialog(ptyId: string, rows: PtyConversationRow[]): PtyPending | null {
    const d = this.sessions.dialogCall(ptyId);
    if (!d) return null;
    const settled = rows.some((r) => resultOf(r, d.toolUseId) || (r.ts >= d.at && isTurnInput(r)));
    return settled ? null : { toolUseId: d.toolUseId, name: d.name, input: d.input };
  }

  private watching(s: PtySession, claudeSessionId: string): Watched {
    const cur = this.watched.get(s.sessionId);
    if (cur?.claudeSessionId === claudeSessionId) return cur;
    this.forget(s.sessionId);
    const path = this.pathOf(s.cwd, claudeSessionId);
    const w: Watched = {
      path, claudeSessionId, cache: null,
      stop: this.watch(path, () => this.bus.publish("pty:conversation", { sessionId: s.sessionId, claudeSessionId })),
    };
    this.watched.set(s.sessionId, w);
    return w;
  }

  private read(w: Watched): TranscriptView {
    let st;
    try { st = statSync(w.path); } catch { return EMPTY; }
    if (w.cache && w.cache.size === st.size && w.cache.mtimeMs === st.mtimeMs) return w.cache.view;
    let text: string;
    try { text = readFileSync(w.path, "utf8"); } catch { return EMPTY; }
    const view = transcriptView(text);
    w.cache = { size: st.size, mtimeMs: st.mtimeMs, view };
    return view;
  }

  private forget(ptyId: string): void {
    this.watched.get(ptyId)?.stop();
    this.watched.delete(ptyId);
  }
}

type RowPayload = { type?: string; role?: string; blocks?: Array<{ callId?: string }> };

const resultOf = (r: PtyConversationRow, callId: string): boolean => {
  const p = r.payload as RowPayload;
  return r.type === "agent_event" && p.role === "tool" && !!p.blocks?.some((b) => b.callId === callId);
};

const isTurnInput = (r: PtyConversationRow): boolean =>
  r.type === "user_message" || (r.type === "agent_event" && (r.payload as RowPayload).type === "turn");
