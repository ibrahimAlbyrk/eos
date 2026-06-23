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

// Minimal ServerResponse surface the route handlers actually touch. Typed
// explicitly so the chaining methods don't self-reference their own initializer.
// `statusCode` is the single source of truth — handlers set it directly or via
// writeHead; `chunks`/`contentType` capture the body.
interface VirtualRes {
  statusCode: number;
  headersSent: boolean;
  chunks: Buffer[];
  contentType: string;
  // Resolves when the handler finishes writing — end() or destroy(). A streaming
  // handler (createReadStream().pipe(res), as /fs/raw and /pdfjs use) returns
  // BEFORE its bytes arrive, so the dispatch must await this, not the handler.
  ended: Promise<void>;
  setHeader(name: string, value: string): void;
  getHeader(): undefined;
  removeHeader(): void;
  writeHead(status: number, headers?: Record<string, string>): VirtualRes;
  write(chunk?: unknown): boolean;
  end(chunk?: unknown): void;
  destroy(): void;
  on(): VirtualRes;
  once(): VirtualRes;
  emit(): boolean;
  removeListener(): VirtualRes;
}

function virtualRes(): VirtualRes {
  let markEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => { markEnded = resolve; });
  const res: VirtualRes = {
    statusCode: 200,
    headersSent: false,
    chunks: [],
    contentType: "",
    ended,
    setHeader(name: string, value: string): void {
      if (name.toLowerCase() === "content-type") res.contentType = value;
    },
    getHeader(): undefined { return undefined; },
    removeHeader(): void {},
    writeHead(status: number, headers?: Record<string, string>): VirtualRes {
      res.statusCode = status;
      const ct = headers?.["content-type"] ?? headers?.["Content-Type"];
      if (ct) res.contentType = ct;
      return res;
    },
    write(chunk?: unknown): boolean { if (chunk != null) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); return true; },
    end(chunk?: unknown): void { if (chunk != null) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); res.headersSent = true; markEnded(); },
    destroy(): void { markEnded(); },
    on(): VirtualRes { return res; },
    once(): VirtualRes { return res; },
    emit(): boolean { return false; },
    removeListener(): VirtualRes { return res; },
  };
  return res;
}

// Build the RouteDispatch the gateway injects into the ControlDispatcher.
export function makeRouteDispatch(router: Router): RouteDispatch {
  return async ({ method, path, body, uiToken }) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (uiToken) headers["x-eos-ui-token"] = uiToken;
    // Route regexes are $-anchored, so match on the PATH only — the real server
    // (daemon.ts) matches url.pathname for the same reason. The full path+query
    // is still handed to the handler via `url` so url.searchParams works (e.g.
    // /workers/:id/events?limit=…&order=…). Matching the raw path+query 404s
    // every query-bearing READ over the control shim.
    const url = new URL(`http://127.0.0.1${path}`);
    const match = router.match(method, url.pathname);
    if (!match) return { status: 404, body: { error: "not found", path } };
    const res = virtualRes();
    const req = virtualReq(method, path, body, headers);
    await match.handler({
      method, path, url,
      params: match.params, req, res: res as unknown as ServerResponse, requestId: "remote",
    });
    await res.ended; // streaming handlers (pipe) complete after the handler returns
    const bytes = Buffer.concat(res.chunks);

    // A non-JSON content-type marks a binary asset route (image/pdf/raw/html/js):
    // carry the raw bytes out-of-band so the utf-8 round-trip below can't corrupt
    // them. The caller (ControlDispatcher) base64-frames them as an `asset`.
    const ct = res.contentType;
    if (ct && !ct.includes("application/json")) {
      return { status: res.statusCode, binary: { mime: ct, bytes } };
    }

    const raw = bytes.toString("utf8");
    let parsed: unknown = raw;
    if (ct.includes("application/json") || /^[[{]/.test(raw.trim())) {
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* keep raw */ }
    }
    return { status: res.statusCode, body: parsed };
  };
}
