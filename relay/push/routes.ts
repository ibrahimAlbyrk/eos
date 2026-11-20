import type { IncomingMessage, ServerResponse } from "node:http";
import { constantTimeHexEqual, sha256Hex } from "../admission.ts";
import { isPushCount, isPushKind } from "./apns.ts";
import type { Pusher } from "./pusher.ts";
import type { PushTokens } from "./tokens.ts";

// The Mac's push while its room socket is closed (07 G38):
//   POST /push/v1/:room  Authorization: Bearer <room owner secret>  {kind, count}
// → 200 {sent, failed, gone, reason?} · 400 bad body · 401 bad bearer · 404 unknown room · 429 throttled.

const BEARER_RE = /^Bearer (\S{1,512})$/;
const MAX_BODY_BYTES = 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// null when the body runs past the cap or is not a JSON object.
function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return resolve(null);
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(v && typeof v === "object" ? (v as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

async function push(req: IncomingMessage, res: ServerResponse, room: string, pusher: Pusher): Promise<void> {
  const body = await readJson(req);
  if (!body || !isPushKind(body.kind) || !isPushCount(body.count)) return send(res, 400, { error: "bad body" });
  const answer = await pusher.push(room, body.kind, body.count);
  if (answer.reason === "throttled") return send(res, 429, { error: "throttled" });
  send(res, 200, answer);
}

// false when the path isn't a push route (the caller answers it).
export function handlePush(req: IncomingMessage, res: ServerResponse, tokens: PushTokens, pusher: Pusher): boolean {
  const url = new URL(req.url ?? "/", "http://relay");
  if (!url.pathname.startsWith("/push/v1/")) return false;
  const m = /^\/push\/v1\/([^/]{1,255})$/.exec(url.pathname);
  if (!m) {
    send(res, 404, { error: "not found" });
    return true;
  }
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    send(res, 405, { error: "method not allowed" });
    return true;
  }
  const auth = BEARER_RE.exec(req.headers.authorization ?? "");
  if (!auth) {
    send(res, 401, { error: "unauthorized" });
    return true;
  }
  const room = m[1];
  const ownerHash = tokens.ownerHash(room);
  if (!ownerHash) {
    send(res, 404, { error: "unknown room" });
    return true;
  }
  if (!constantTimeHexEqual(sha256Hex(auth[1]), ownerHash)) {
    send(res, 401, { error: "unauthorized" });
    return true;
  }
  push(req, res, room, pusher).catch(() => send(res, 500, { error: "push failed" }));
  return true;
}
