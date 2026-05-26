// Local HTTP server for two ingress paths: user messages from the daemon
// and Claude's HTTP-type hooks (SessionStart/Stop/PostToolUse/SessionEnd/
// Notification). Body parsing is best-effort — malformed JSON is treated
// as an empty object so the hook delivery still works.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface IngestHandlers {
  onMessage(text: string): void;
  onInterrupt(): { ok: boolean; reason?: string };
  onHook(eventName: string, body: Record<string, unknown>): void;
}

export interface IngestServer {
  close(): void;
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
          const body = JSON.parse(raw) as { text?: string };
          if (!body.text) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "text required" }));
            return;
          }
          handlers.onMessage(body.text);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
        return;
      }
      if (url.pathname === "/interrupt") {
        const result = handlers.onInterrupt();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
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
