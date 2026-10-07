// Host side of a peer link: every HTTP/2 stream from a paired device becomes a
// plain HTTP/1.1 request to THIS daemon's own local endpoints — the unix socket
// for the API, loopback TCP for the raw-content origin. Route handlers see an
// ordinary local request (streaming, SSE, Range all behave as on this Mac), so
// the only peer-specific code is this security boundary:
//   * local-plane routes never cross (route-planes.ts),
//   * only the device's human dashboard gets past the host's public face,
//   * identity headers are always the gateway's, never the device's.

import http from "node:http";
import http2 from "node:http2";
import type { Readable } from "node:stream";
import zlib from "node:zlib";

import { PEER_DEVICE_HEADER, PEER_HUMAN_HEADER } from "../../contracts/src/peer.ts";
import { isLocalOnlyRoute, isPeerOpenRoute } from "../../contracts/src/route-planes.ts";
import { safeStringify } from "../../infra/src/util/json.ts";

export interface LocalDaemonTarget {
  socketPath: string;
  rawHost: string;
  rawPort: number;
  uiToken: string;
}

// Connection-scoped (RFC 9113 §8.2.2) or re-set by the gateway below.
const DROP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "host", "trailer",
  "x-eos-ui-token", PEER_DEVICE_HEADER, PEER_HUMAN_HEADER, "x-eos-agent-id",
]);

// Checked and forwarded in the form the local router will resolve it to — or
// "/ui/../policy/decide" would pass every rule below as "/ui/…".
function normalizePath(path: string): string {
  const u = new URL(path, "http://localhost");
  return u.pathname + u.search;
}

function isRawPlane(path: string): boolean {
  return path.startsWith("/fs/raw/") || path === "/pdfjs" || path.startsWith("/pdfjs/");
}

// Event streams (agent tokens, terminal bytes) arrive as many tiny writes; each
// would cost its own HTTP/2 frame and TLS record on the wire. The first write
// after a quiet spell goes out at once (a keystroke's echo, a turn's first
// token); whatever follows within the window rides one frame.
export function coalesceStream(
  src: Readable,
  dst: { write(chunk: Buffer): boolean; end(): void; once(ev: "drain", cb: () => void): unknown },
  windowMs = 8,
  maxBytes = 16 * 1024,
): void {
  let pending: Buffer[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let windowOpen = false;
  const flush = (): void => {
    if (size === 0) return;
    const chunk = pending.length === 1 ? pending[0] : Buffer.concat(pending);
    pending = [];
    size = 0;
    if (!dst.write(chunk)) {
      src.pause();
      dst.once("drain", () => src.resume());
    }
  };
  const closeWindow = (): void => {
    timer = null;
    if (size > 0) { flush(); timer = setTimeout(closeWindow, windowMs); return; }
    windowOpen = false;
  };
  src.on("data", (c: Buffer | string) => {
    pending.push(typeof c === "string" ? Buffer.from(c) : c);
    size += pending[pending.length - 1].length;
    if (!windowOpen) {
      windowOpen = true;
      flush();
      timer = setTimeout(closeWindow, windowMs);
    } else if (size >= maxBytes) {
      flush();
    }
  });
  src.on("end", () => {
    if (timer) clearTimeout(timer);
    flush();
    dst.end();
  });
}

export function respondJson(stream: http2.ServerHttp2Stream, status: number, body: unknown): void {
  if (stream.destroyed || stream.closed) return;
  if (!stream.headersSent) stream.respond({ ":status": status, "content-type": "application/json" });
  stream.end(safeStringify(body));
}

export function createLocalForwarder(target: LocalDaemonTarget): {
  forward(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, deviceFp: string): void;
  close(): void;
} {
  const udsAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
  const rawAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

  function forward(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders, deviceFp: string): void {
    const method = String(headers[":method"] ?? "GET");
    const path = normalizePath(String(headers[":path"] ?? "/"));
    if (isLocalOnlyRoute(method, path)) {
      respondJson(stream, 403, { error: "not available from another device", path });
      return;
    }
    // The device's daemon vouches its caller was its own human dashboard; an
    // agent on that machine gets no more reach here than an agent on this one.
    // Held here too, not only by the device's facade: a device may be older.
    const human = headers[PEER_HUMAN_HEADER] === "1";
    if (!human && !isPeerOpenRoute(method, path)) {
      respondJson(stream, 403, { error: "only the Eos window can do this on another computer", code: "needs-human", path });
      return;
    }
    const out: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith(":") || v === undefined || DROP_HEADERS.has(k)) continue;
      out[k] = v;
    }
    out.host = "localhost";
    if (human) out["x-eos-ui-token"] = target.uiToken;
    out[PEER_DEVICE_HEADER] = deviceFp;

    const raw = isRawPlane(path);
    const req = http.request({
      ...(raw ? { host: target.rawHost, port: target.rawPort, agent: rawAgent } : { socketPath: target.socketPath, agent: udsAgent }),
      method, path, headers: out,
    });
    // Once the local response is complete its socket is back in the keep-alive
    // pool and may carry another request — destroying `req` then would kill it.
    let finished = false;
    req.on("response", (res) => {
      res.once("end", () => { finished = true; });
      if (stream.destroyed || stream.closed) { res.destroy(); return; }
      const h: http2.OutgoingHttpHeaders = { ":status": res.statusCode ?? 502 };
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined && !DROP_HEADERS.has(k)) h[k] = v;
      }
      const events = String(res.headers["content-type"] ?? "").startsWith("text/event-stream");
      // Event frames are verbose, repetitive JSON — one gzip context per stream
      // shrinks them ~8x. Every write is sync-flushed, so a frame is still
      // readable on the device the moment it leaves here.
      const gzipEvents = events && !res.headers["content-encoding"] && /\bgzip\b/.test(String(headers["accept-encoding"] ?? ""));
      if (gzipEvents) { h["content-encoding"] = "gzip"; h.vary = "accept-encoding"; }
      stream.respond(h);
      if (gzipEvents) {
        const gz = zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH });
        gz.on("error", () => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
        gz.pipe(stream);
        coalesceStream(res, gz);
      } else if (events) coalesceStream(res, stream);
      else res.pipe(stream);
      res.on("error", () => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
    });
    req.on("error", (e) => {
      if (!stream.headersSent) respondJson(stream, 502, { error: `local daemon unreachable: ${e.message}` });
      else stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    });
    // A device that goes away (closed tab, dropped link) must release the local
    // request too — otherwise an SSE stream here would stream into nothing.
    stream.on("close", () => { if (!finished) req.destroy(); });
    stream.pipe(req);
  }

  return {
    forward,
    close: () => { udsAgent.destroy(); rawAgent.destroy(); },
  };
}
