// Request ID — accept inbound X-Request-Id when a caller already minted one,
// otherwise mint our own. Echo on the response so callers can correlate
// with daemon logs.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IdGenerator } from "../../core/src/ports/IdGenerator.ts";

export function mintRequestId(req: IncomingMessage, res: ServerResponse, ids: IdGenerator): string {
  const incoming = req.headers["x-request-id"];
  const id = String(Array.isArray(incoming) ? incoming[0] : incoming || ids.newRequestId());
  res.setHeader("x-request-id", id);
  return id;
}
