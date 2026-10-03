// Maps domain errors → HTTP status codes. Anything not a known domain error
// becomes 500 with the bare message. The structured logger receives every
// failure so /metrics + log shippers can act on it.

import type { ServerResponse } from "node:http";
import { gzip } from "node:zlib";
import { createHash } from "node:crypto";
import {
  DomainError,
  NotFoundError,
  ConflictError,
  ValidationError,
  PermissionDeniedError,
  LimitExceededError,
  UnreachableError,
} from "../../core/src/errors/index.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import { errMsg } from "../../contracts/src/util.ts";
import { BodyTooLargeError } from "./bodyReader.ts";
import { fdStats } from "../../infra/src/util/fd-stats.ts";

// EMFILE/ENFILE = the process/system fd table is full; an EBADF on a spawn/open
// under load is the same exhaustion surfacing on whichever syscall lost the race
// for the last descriptor. Returns the errno (for the response) or null.
function fdErrno(e: unknown): string | null {
  const code = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  if (code === "EMFILE" || code === "ENFILE" || code === "EBADF") return code;
  const msg = e instanceof Error ? e.message : "";
  const m = msg.match(/\b(EMFILE|ENFILE|EBADF)\b/);
  if (m) return m[1];
  return /too many open files/i.test(msg) ? "EMFILE" : null;
}

// Below this size gzip overhead beats the savings; above it, JSON shrinks
// several times (lists, diffs, file contents) — over a peer link every KB is
// relay time. Compression is async so a multi-MB body never blocks the event loop.
const GZIP_MIN_BYTES = 1024;
// A GET answer worth tagging: the client's HTTP cache revalidates it, and an
// unchanged one (the same list read again) costs a 304 instead of the body.
const ETAG_MIN_BYTES = 512;

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  const req = res.req;
  const bytes = Buffer.byteLength(json, "utf8");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (status === 200 && req?.method === "GET" && bytes >= ETAG_MIN_BYTES) {
    const etag = `W/"${createHash("sha1").update(json).digest("base64url")}"`;
    headers.etag = etag;
    // Revalidate every time: the tag, not an age, says whether it changed.
    if (!res.getHeader?.("cache-control")) headers["cache-control"] = "no-cache";
    if (req.headers?.["if-none-match"] === etag) {
      res.writeHead(304, { etag, ...(headers["cache-control"] ? { "cache-control": headers["cache-control"] } : {}) });
      res.end();
      return;
    }
  }
  const accept = String(req?.headers["accept-encoding"] ?? "");
  if (bytes >= GZIP_MIN_BYTES && /\bgzip\b/.test(accept)) {
    gzip(json, (err, buf) => {
      if (err) {
        res.writeHead(status, headers);
        res.end(json);
        return;
      }
      res.writeHead(status, { ...headers, "content-encoding": "gzip" });
      res.end(buf);
    });
    return;
  }
  res.writeHead(status, headers);
  res.end(json);
}

export function handleError(
  res: ServerResponse,
  e: unknown,
  ctx: { requestId: string; method: string; path: string; log: Logger; metrics?: { bodyTooLarge?: number } },
): void {
  if (e instanceof BodyTooLargeError) {
    if (ctx.metrics) ctx.metrics.bodyTooLarge = (ctx.metrics.bodyTooLarge ?? 0) + 1;
    ctx.log.warn("body too large rejected", { request_id: ctx.requestId, method: ctx.method, path: ctx.path, limit: e.limit });
    writeJson(res, 413, { error: e.message, limit: e.limit });
    return;
  }
  if (e instanceof NotFoundError) {
    writeJson(res, 404, { error: e.message });
    return;
  }
  if (e instanceof ConflictError) {
    writeJson(res, 409, { error: e.message });
    return;
  }
  if (e instanceof ValidationError) {
    writeJson(res, 400, { error: e.message });
    return;
  }
  if (e instanceof PermissionDeniedError) {
    writeJson(res, 403, { error: e.message });
    return;
  }
  if (e instanceof LimitExceededError) {
    writeJson(res, 429, { error: e.message });
    return;
  }
  if (e instanceof UnreachableError) {
    writeJson(res, 502, { error: e.message });
    return;
  }
  if (e instanceof DomainError) {
    writeJson(res, 400, { error: e.message });
    return;
  }
  const fdCode = fdErrno(e);
  if (fdCode) {
    const { open, limit } = fdStats();
    const detail = open != null && limit != null ? ` (${open}/${limit} fds open)` : "";
    ctx.log.error("fd exhaustion", { request_id: ctx.requestId, method: ctx.method, path: ctx.path, error: errMsg(e), open, limit });
    writeJson(res, 503, { error: `daemon ran out of file descriptors${detail} — reduce concurrent workers or restart the daemon`, code: fdCode });
    return;
  }

  const msg = errMsg(e);
  ctx.log.error("request failed", { request_id: ctx.requestId, method: ctx.method, path: ctx.path, error: msg });
  writeJson(res, 500, { error: msg });
}
