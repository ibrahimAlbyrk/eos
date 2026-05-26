// Tails Claude's JSONL transcript file with chokidar, parses each line via
// jsonl-parser, and emits resulting events. Stateful: tracks the byte
// offset so chunked writes don't replay or get lost. The watcher handle is
// returned so the cleanup path can close it (chokidar inotify handles
// outlive the worker otherwise and leak FDs).

import { openSync, readSync, closeSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import chokidar from "chokidar";
import { parseJsonlLine } from "./jsonl-parser.ts";
import { encodeCwd } from "./worktree.ts";

export interface TailHandle {
  readonly path: string;
  close(): void;
}

export interface TailContext {
  cwd: string;
  sessionId: string;
  defaultModel: string;
  name: string;
  onEvent(type: string, payload: unknown): void;
  onActivity?(): void;
}

export function startJsonlTail(ctx: TailContext): TailHandle {
  const jsonlPath = join(homedir(), ".claude", "projects", encodeCwd(ctx.cwd), `${ctx.sessionId}.jsonl`);
  console.log(`[${ctx.name}] tail=${jsonlPath}`);
  let offset = 0;
  const watcher = chokidar.watch(jsonlPath, { ignoreInitial: false, awaitWriteFinish: false });
  const readNew = (): void => {
    if (!existsSync(jsonlPath)) return;
    const stat = statSync(jsonlPath);
    if (stat.size <= offset) return;
    const fd = openSync(jsonlPath, "r");
    try {
      const buf = Buffer.alloc(stat.size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = stat.size;
      for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
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
    close(): void {
      try { watcher.close(); } catch {}
    },
  };
}
