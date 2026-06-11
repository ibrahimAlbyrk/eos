// Maps domain errors → HTTP status codes. Anything not a known domain error
// becomes 500 with the bare message. The structured logger receives every
// failure so /metrics + log shippers can act on it.

import type { ServerResponse } from "node:http";
import { gzip } from "node:zlib";
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

// Below this size gzip overhead beats the savings; above it, large payloads
// (whole-tree diffs, file contents) shrink ~5-10x. Compression is async so a
// multi-MB body never blocks the event loop.
const GZIP_MIN_BYTES = 8 * 1024;

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  const accept = String(res.req?.headers["accept-encoding"] ?? "");
  if (Buffer.byteLength(json, "utf8") >= GZIP_MIN_BYTES && /\bgzip\b/.test(accept)) {
    gzip(json, (err, buf) => {
      if (err) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(json);
        return;
      }
      res.writeHead(status, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(buf);
    });
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
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
  const msg = errMsg(e);
  ctx.log.error("request failed", { request_id: ctx.requestId, method: ctx.method, path: ctx.path, error: msg });
  writeJson(res, 500, { error: msg });
}
