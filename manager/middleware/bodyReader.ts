// Body reading with a size cap. 1 MB ceiling — daemon is localhost-only,
// but a buggy / hostile client could otherwise pour unlimited bytes into
// memory. Rejecting early kills the chunk pipe so we don't keep buffering.

import type { IncomingMessage } from "node:http";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`request body too large (limit ${limit} bytes)`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

export async function readBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let aborted = false;
    req.on("data", (c: Buffer | string) => {
      if (aborted) return;
      size += typeof c === "string" ? Buffer.byteLength(c) : c.length;
      if (size > maxBytes) {
        aborted = true;
        try { req.destroy(); } catch {}
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      raw += c;
    });
    req.on("end", () => {
      if (aborted) return;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
