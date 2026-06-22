// Virtual-response shim (design §2.1). Turns a decrypted control{method,path,
// body} into a call against the EXISTING Router + route handlers, with no real
// socket — a Readable carrying the body JSON plus a capturing ServerResponse.
// This is the DRY core: remote control reuses the same handlers the local REST
// API exercises, so there is no parallel command surface to maintain.
//
// The gateway supplies the local x-eos-ui-token here (and ONLY here) for a ✦
// route the device is entitled to (§4.5); the token never leaves the daemon.

import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Router } from "../routes/Router.ts";
import type { RouteDispatch } from "./dispatch.ts";

function virtualReq(method: string, path: string, body: unknown, headers: Record<string, string>): IncomingMessage {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []) as unknown as IncomingMessage;
  req.headers = headers;
  req.method = method;
  req.url = path;
  return req;
}

interface CapturingRes {
  statusCode: number;
  chunks: Buffer[];
  contentType: string;
}

function virtualRes(): { res: ServerResponse; captured: CapturingRes } {
  const captured: CapturingRes = { statusCode: 200, chunks: [], contentType: "" };
  const push = (chunk?: unknown): void => {
    if (chunk == null) return;
    captured.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  };
  const res = {
    get statusCode(): number { return captured.statusCode; },
    set statusCode(v: number) { captured.statusCode = v; },
    headersSent: false,
    setHeader(name: string, value: string): void {
      if (name.toLowerCase() === "content-type") captured.contentType = value;
    },
    getHeader(): undefined { return undefined; },
    removeHeader(): void {},
    writeHead(status: number, headers?: Record<string, string>): typeof res {
      captured.statusCode = status;
      const ct = headers?.["content-type"] ?? headers?.["Content-Type"];
      if (ct) captured.contentType = ct;
      return res;
    },
    write(chunk?: unknown): boolean { push(chunk); return true; },
    end(chunk?: unknown): void { push(chunk); },
    on(): typeof res { return res; },
    once(): typeof res { return res; },
    emit(): boolean { return false; },
    removeListener(): typeof res { return res; },
  };
  return { res: res as unknown as ServerResponse, captured };
}

// Build the RouteDispatch the gateway injects into the ControlDispatcher.
export function makeRouteDispatch(router: Router): RouteDispatch {
  return async ({ method, path, body, uiToken }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (uiToken) headers["x-eos-ui-token"] = uiToken;
    const match = router.match(method, path);
    if (!match) return { status: 404, body: { error: "not found", path } };
    const { res, captured } = virtualRes();
    const req = virtualReq(method, path, body, headers);
    await match.handler({
      method, path, url: new URL(`http://127.0.0.1${path}`),
      params: match.params, req, res, requestId: "remote",
    });
    const raw = Buffer.concat(captured.chunks).toString("utf8");
    let parsed: unknown = raw;
    if (captured.contentType.includes("application/json") || /^[[{]/.test(raw.trim())) {
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* keep raw */ }
    }
    return { status: captured.statusCode, body: parsed };
  };
}
