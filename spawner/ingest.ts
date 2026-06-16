// Local HTTP server for the worker's ingress paths: user/orchestrator messages
// and keystrokes from the daemon, plus Claude's HTTP-type hooks (SessionStart/
// Stop/PostToolUse/SessionEnd/Notification). Each request is parsed into a typed
// WorkerInput (parseWorkerInput — pure + unit-tested) and routed by kind through
// one dispatcher, instead of a per-path if-ladder. Body parsing is strict where
// the daemon owns the payload (/message, /keystroke → malformed JSON is a 500)
// and best-effort where Claude's hooks need it (/event, /rewind → malformed JSON
// degrades to an empty object so delivery still works).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { errMsg } from "../contracts/src/util.ts";
import type { MessageRecord } from "./message-registry.ts";

export interface IngestHandlers {
  onMessage(text: string, record?: MessageRecord): void;
  onKeystroke(keys: string): void;
  onInterrupt(): { ok: boolean; reason?: string };
  /** Optional return value is sent back as the hook's HTTP response body —
   * Claude honors it as hook output (e.g. a PreToolUse permission deny). */
  onHook(eventName: string, body: Record<string, unknown>): Record<string, unknown> | undefined;
  onRewindTargets(): unknown;
  onRewind(body: { uuid?: string; mode?: string }): Promise<unknown>;
}

export interface IngestServer {
  close(): void;
}

// The typed shape of every daemon→worker / hook→worker ingress, discriminated by
// kind. The HTTP layer parses a request into this; one dispatcher routes on it.
// Transport (pipeline vs raw write) and chat-event emission stay in the worker's
// handlers — this union is only the ingress contract.
export type WorkerInput =
  | { kind: "message"; text: string; record?: MessageRecord }
  | { kind: "keystroke"; keys: string }
  | { kind: "interrupt" }
  | { kind: "rewindTargets" }
  | { kind: "rewind"; body: { uuid?: string; mode?: string } }
  | { kind: "hook"; eventName: string; body: Record<string, unknown> };

export type ParseResult =
  | { ok: true; input: WorkerInput }
  | { ok: false; status: number; error: string };

// Best-effort, like the rest of the body parsing: a malformed record must not
// block message delivery — it just degrades to "no chat event from this worker".
export function parseRecord(raw: unknown): MessageRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as { as?: unknown; displayText?: unknown; clientMsgIds?: unknown; fromParent?: unknown; parentName?: unknown; fromWorker?: unknown; workerName?: unknown; fromName?: unknown; sentAt?: unknown };
  const sentAt = typeof r.sentAt === "number" ? { sentAt: r.sentAt } : {};
  if (r.as === "user_message") {
    const clientMsgIds = Array.isArray(r.clientMsgIds)
      ? r.clientMsgIds.filter((x): x is string => typeof x === "string")
      : [];
    return {
      as: "user_message",
      ...(typeof r.displayText === "string" ? { displayText: r.displayText } : {}),
      ...(clientMsgIds.length > 0 ? { clientMsgIds } : {}),
      ...sentAt,
    };
  }
  if (r.as === "orchestrator_message" && typeof r.fromParent === "string") {
    return {
      as: "orchestrator_message",
      fromParent: r.fromParent,
      ...(typeof r.parentName === "string" ? { parentName: r.parentName } : {}),
      ...sentAt,
    };
  }
  if (r.as === "worker_report" && typeof r.fromWorker === "string") {
    return {
      as: "worker_report",
      fromWorker: r.fromWorker,
      ...(typeof r.workerName === "string" ? { workerName: r.workerName } : {}),
      ...(typeof r.displayText === "string" ? { displayText: r.displayText } : {}),
      ...sentAt,
    };
  }
  if (r.as === "peer_request" && typeof r.fromWorker === "string") {
    return {
      as: "peer_request",
      fromWorker: r.fromWorker,
      ...(typeof r.fromName === "string" ? { fromName: r.fromName } : {}),
      ...(typeof r.displayText === "string" ? { displayText: r.displayText } : {}),
      ...sentAt,
    };
  }
  return undefined;
}

// Pure ingress parser. Mirrors the original per-path validation EXACTLY:
//  /message, /keystroke        strict: malformed JSON → 500, missing field → 400
//  /interrupt, /rewind-targets no body
//  /rewind, /event (default)   tolerant: malformed JSON degrades to an empty body
export function parseWorkerInput(pathname: string, search: URLSearchParams, raw: string): ParseResult {
  if (pathname === "/message") {
    let body: { text?: string; record?: unknown };
    try { body = JSON.parse(raw); } catch (e) { return { ok: false, status: 500, error: errMsg(e) }; }
    if (!body.text) return { ok: false, status: 400, error: "text required" };
    return { ok: true, input: { kind: "message", text: body.text, record: parseRecord(body.record) } };
  }
  if (pathname === "/keystroke") {
    let body: { keys?: string };
    try { body = JSON.parse(raw); } catch (e) { return { ok: false, status: 500, error: errMsg(e) }; }
    if (!body.keys) return { ok: false, status: 400, error: "keys required" };
    return { ok: true, input: { kind: "keystroke", keys: body.keys } };
  }
  if (pathname === "/interrupt") return { ok: true, input: { kind: "interrupt" } };
  if (pathname === "/rewind-targets") return { ok: true, input: { kind: "rewindTargets" } };
  if (pathname === "/rewind") {
    let body: { uuid?: string; mode?: string } = {};
    try { body = JSON.parse(raw); } catch { /* tolerate — empty body */ }
    return { ok: true, input: { kind: "rewind", body } };
  }
  // default: /event?event=<name>
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw); } catch { /* tolerate — empty body */ }
  return { ok: true, input: { kind: "hook", eventName: search.get("event") ?? "Unknown", body } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Route a parsed input to its handler and write the HTTP response. /message and
// /keystroke wrap the handler call in try/catch → 500, preserving the original
// behavior; /rewind is the only async path.
function dispatch(input: WorkerInput, handlers: IngestHandlers, res: ServerResponse): void {
  switch (input.kind) {
    case "message":
      try {
        handlers.onMessage(input.text, input.record);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 500, { error: errMsg(e) });
      }
      return;
    case "keystroke":
      try {
        handlers.onKeystroke(input.keys);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 500, { error: errMsg(e) });
      }
      return;
    case "interrupt":
      sendJson(res, 200, handlers.onInterrupt());
      return;
    case "rewindTargets":
      sendJson(res, 200, handlers.onRewindTargets());
      return;
    case "rewind":
      handlers.onRewind(input.body).then(
        (result) => sendJson(res, 200, result),
        (e) => sendJson(res, 500, { ok: false, error: errMsg(e) }),
      );
      return;
    case "hook":
      sendJson(res, 200, handlers.onHook(input.eventName, input.body) ?? { continue: true });
      return;
  }
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
          sendJson(res, 413, { error: "body too large" });
          req.destroy();
        }
        return;
      }
      raw += c;
    });
    req.on("end", () => {
      if (rejected) return;
      const parsed = parseWorkerInput(url.pathname, url.searchParams, raw);
      if (!parsed.ok) {
        sendJson(res, parsed.status, { error: parsed.error });
        return;
      }
      dispatch(parsed.input, handlers, res);
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
