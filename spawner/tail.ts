// Tails Claude's JSONL transcript file with chokidar, parses each line via
// jsonl-parser, and emits resulting events. Stateful: tracks the byte
// offset so chunked writes don't replay or get lost. The watcher handle is
// returned so the cleanup path can close it (chokidar inotify handles
// outlive the worker otherwise and leak FDs).

import { openSync, readSync, closeSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import chokidar from "chokidar";
import { parseJsonlLine } from "./jsonl-parser.ts";
import { LineFramer } from "./line-framer.ts";
import { encodeCwd } from "./worktree.ts";

export interface TailHandle {
  readonly path: string;
  /** Synchronously read the file to EOF and emit everything pending. Called
   *  before forwarding Stop/SessionEnd/interrupt so trailing transcript lines
   *  are emitted ahead of the turn-end event (deterministic ordering). */
  drainNow(): void;
  close(): void;
}

export interface TailContext {
  cwd: string;
  sessionId: string;
  defaultModel: string;
  name: string;
  /** Start reading at the current end of file instead of offset 0. Used on
   *  resume, where the transcript already holds the full prior conversation —
   *  replaying it would duplicate chat events and double-count usage cost. */
  startAtEof?: boolean;
  onEvent(type: string, payload: unknown): void;
  onActivity?(): void;
}

// Locate the transcript /clear just created. Claude's http SessionStart hook
// never fires (empirically — not even at startup), so the only way to learn
// the new session id is to find the new file itself. Discriminators: not the
// old session, written after the clear, and its head contains the local
// command record "<command-name>/clear" — that last check keeps a concurrent
// worker sharing the same cwd from being mistaken for our new session.
export function findClearedSessionJsonl(cwd: string, excludeSessionId: string, sinceMs: number): string | null {
  const dir = join(homedir(), ".claude", "projects", encodeCwd(cwd));
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  let best: { id: string; mtime: number } | null = null;
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    const id = n.slice(0, -".jsonl".length);
    if (id === excludeSessionId) continue;
    let mtime = 0;
    try { mtime = statSync(join(dir, n)).mtimeMs; } catch { continue; }
    if (mtime < sinceMs) continue;
    let head = "";
    try { head = readFileSync(join(dir, n), "utf8").slice(0, 8192); } catch { continue; }
    if (!head.includes("<command-name>/clear")) continue;
    if (!best || mtime > best.mtime) best = { id, mtime };
  }
  return best?.id ?? null;
}

export function startJsonlTail(ctx: TailContext): TailHandle {
  const jsonlPath = join(homedir(), ".claude", "projects", encodeCwd(ctx.cwd), `${ctx.sessionId}.jsonl`);
  let offset = 0;
  if (ctx.startAtEof) {
    try { offset = statSync(jsonlPath).size; } catch {}
  }
  console.log(`[${ctx.name}] tail=${jsonlPath}${offset > 0 ? ` (from offset ${offset})` : ""}`);
  const watcher = chokidar.watch(jsonlPath, { ignoreInitial: false, awaitWriteFinish: false });
  // Framing through LineFramer, not split("\n"): a read can land mid-write,
  // and the offset advances past the half-written line — without the carry
  // buffer that line would parse as broken JSON once and be lost forever.
  const framer = new LineFramer();
  const readNew = (): void => {
    if (!existsSync(jsonlPath)) return;
    const stat = statSync(jsonlPath);
    if (stat.size <= offset) return;
    const fd = openSync(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(stat.size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = stat.size;
      for (const line of framer.push(buf)) {
        parseJsonlLine(line, (type, payload) => {
          ctx.onEvent(type, payload);
          if (type === "jsonl") {
            const p = payload as { kind: string; name?: string; text?: string; isError?: boolean };
            if (p.kind === "assistant_text") {
              console.log(`[${ctx.name}][jsonl] assistant ${(p.text ?? "").slice(0, 80).replace(/\s+/g, " ")}`);
            } else if (p.kind === "tool_use") {
              console.log(`[${ctx.name}][jsonl] tool_use ${p.name}`);
            } else if (p.kind === "thinking") {
              console.log(`[${ctx.name}][jsonl] thinking ${(p.text ?? "").slice(0, 80).replace(/\s+/g, " ")}`);
            } else if (p.kind === "tool_result") {
              console.log(`[${ctx.name}][jsonl] tool_result ${p.isError ? "ERR " : ""}${(p.text ?? "").slice(0, 80).replace(/\s+/g, " ")}`);
            }
            if (p.kind === "assistant_text" || p.kind === "tool_use" || p.kind === "thinking") {
              ctx.onActivity?.();
            }
          }
        }, ctx.defaultModel);
      }
    } finally {
      closeSync(fd);
    }
  };
  watcher.on("add", readNew).on("change", readNew);
  return {
    path: jsonlPath,
    drainNow(): void {
      try { readNew(); } catch {}
    },
    close(): void {
      try { watcher.close(); } catch {}
    },
  };
}
