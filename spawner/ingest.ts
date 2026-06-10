// Local HTTP server for two ingress paths: user messages from the daemon
// and Claude's HTTP-type hooks (SessionStart/Stop/PostToolUse/SessionEnd/
// Notification). Body parsing is best-effort — malformed JSON is treated
// as an empty object so the hook delivery still works.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { errMsg } from "../contracts/src/util.ts";
import type { MessageRecord } from "./message-registry.ts";

export interface QuestionAnswer {
  answers: Record<string, string>;
}

export interface IngestHandlers {
  onMessage(text: string, record?: MessageRecord): void;
  onAnswer(selections: unknown[]): Promise<{ ok: boolean; outcome: string }>;
  onKeystroke(keys: string): void;
  onInterrupt(): { ok: boolean; reason?: string };
  onHook(eventName: string, body: Record<string, unknown>): void;
  onQuestionHook(body: Record<string, unknown>): Promise<QuestionAnswer | null>;
  onRewindTargets(): unknown;
  onRewind(body: { uuid?: string; mode?: string }): Promise<unknown>;
}

export interface IngestServer {
  close(): void;
}

// Best-effort, like the rest of the body parsing: a malformed record must not
// block message delivery — it just degrades to "no chat event from this worker".
function parseRecord(raw: unknown): MessageRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { as?: unknown; displayText?: unknown; fromParent?: unknown; parentName?: unknown; fromWorker?: unknown; workerName?: unknown };
  if (r.as === "user_message") {
    return { as: "user_message", ...(typeof r.displayText === "string" ? { displayText: r.displayText } : {}) };
  }
  if (r.as === "orchestrator_message" && typeof r.fromParent === "string") {
    return {
      as: "orchestrator_message",
      fromParent: r.fromParent,
      ...(typeof r.parentName === "string" ? { parentName: r.parentName } : {}),
    };
  }
  if (r.as === "worker_report" && typeof r.fromWorker === "string") {
    return {
      as: "worker_report",
      fromWorker: r.fromWorker,
      ...(typeof r.workerName === "string" ? { workerName: r.workerName } : {}),
      ...(typeof r.displayText === "string" ? { displayText: r.displayText } : {}),
    };
  }
  return undefined;
}

export function startIngestServer(port: number, handlers: IngestHandlers): IngestServer {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    let raw = "";
    let size = 0;
    let rejected = false;
    req.on("error", () => { /* client disconnect — ignore */ });
    req.on("data", (c: Buffer | string) => {
      size += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (size > 1_048_576) {
        if (!rejected) {
          rejected = true;
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body too large" }));
          req.destroy();
        }
        return;
      }
      raw += c;
    });
    req.on("end", () => {
      if (rejected) return;
      if (url.pathname === "/message") {
        try {
          const body = JSON.parse(raw) as { text?: string; record?: unknown };
          if (!body.text) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "text required" }));
            return;
          }
          handlers.onMessage(body.text, parseRecord(body.record));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: errMsg(e) }));
        }
        return;
      }
      if (url.pathname === "/keystroke") {
        try {
          const body = JSON.parse(raw) as { keys?: string };
          if (!body.keys) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "keys required" }));
            return;
          }
          handlers.onKeystroke(body.keys);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: errMsg(e) }));
        }
        return;
      }
      if (url.pathname === "/answer") {
        let body: { selections?: unknown[] } = {};
        try { body = JSON.parse(raw); } catch {}
        const selections = Array.isArray(body.selections) ? body.selections : [];
        handlers.onAnswer(selections).then(
          (result) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
          },
          (e) => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: errMsg(e) }));
          },
        );
        return;
      }
      if (url.pathname === "/interrupt") {
        const result = handlers.onInterrupt();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      if (url.pathname === "/rewind-targets") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(handlers.onRewindTargets()));
        return;
      }
      if (url.pathname === "/rewind") {
        let body: { uuid?: string; mode?: string } = {};
        try { body = JSON.parse(raw); } catch {}
        handlers.onRewind(body).then(
          (result) => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(result));
          },
          (e) => {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: errMsg(e) }));
          },
        );
        return;
      }
      // /event?event=<name>
      const eventName = url.searchParams.get("event") ?? "Unknown";
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw); } catch {}
      handlers.onHook(eventName, body);


      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ continue: true }));
    });
  });
  server.on("error", (err: Error) => {
    console.error(`[ingest] server error: ${err.message}`);
    throw err;
  });
  server.listen(port, "127.0.0.1");
  return {
    close(): void {
      try { server.close(); } catch {}
    },
  };
}
