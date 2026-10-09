// Which browser pages may call the API server. Only the dashboard: the bundled
// app UI (eos://app — the main window and every host view, each in its own
// partition) and a page the daemon serves itself (its /ui bundle opened on the
// loopback port). Everything else that sends an Origin is refused outright — not
// just left without CORS headers, because a "simple" request (a text/plain POST)
// runs before the browser ever checks them. That covers "null" (a sandboxed
// iframe: an agent-authored app, an HTML preview), the raw-content port's
// untrusted files, and any web page in any browser on this Mac.
//
// Clients that send no Origin are not browsers' cross-origin calls — CLI, MCP
// servers, hooks, the app's main process — and pass; the loopback lock and the
// ui-token gates still apply to them. The Vite dev server isn't on the list
// because nothing uses one: `npm run dev` in app/ui is `vite build --watch`,
// loaded through eos://app like a release build.

import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "./errorHandler.ts";

export const APP_ORIGIN = "eos://app";

// The daemon's own origins on its API port. Fixed loopback names, never the
// request's Host header — that would let a DNS-rebound page vouch for itself.
export function apiOrigins(port: number): ReadonlySet<string> {
  return new Set([APP_ORIGIN, `http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
}

// A DNS-rebound page reaches the loopback port under its own name and, being
// same-origin to itself, sends no Origin — so the Host header is what tells it
// apart. Only loopback names (any port) and the configured bind address pass; a
// request with no Host isn't a browser's.
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export function apiHosts(bindHost?: string | null): ReadonlySet<string> {
  const hosts = new Set(LOOPBACK_HOSTS);
  const bind = bindHost?.trim().toLowerCase();
  if (bind && bind !== "0.0.0.0" && bind !== "::" && bind !== "[::]") hosts.add(bind.includes(":") && !bind.startsWith("[") ? `[${bind}]` : bind);
  return hosts;
}

export function hostAllowed(header: string | string[] | undefined, allowed: ReadonlySet<string>): boolean {
  if (header === undefined || header === "") return true;
  if (Array.isArray(header)) return false;
  if (/[/@?#\\\s]/.test(header)) return false;
  try {
    return allowed.has(new URL(`http://${header}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type OriginVerdict = { kind: "none" } | { kind: "allowed"; origin: string } | { kind: "refused" };

export function checkOrigin(header: string | string[] | undefined, allowed: ReadonlySet<string>): OriginVerdict {
  if (header === undefined) return { kind: "none" };
  // A repeated Origin header is never a browser's.
  if (Array.isArray(header)) return { kind: "refused" };
  return allowed.has(header) ? { kind: "allowed", origin: header } : { kind: "refused" };
}

// Answers what CORS decides on its own (a refused origin, a preflight) and sets
// the response headers otherwise. false = the response is already written.
export function applyCors(req: IncomingMessage, res: ServerResponse, allowed: ReadonlySet<string>): boolean {
  const verdict = checkOrigin(req.headers.origin, allowed);
  res.setHeader("vary", "Origin");
  if (verdict.kind === "refused") {
    writeJson(res, 403, { error: "origin not allowed" });
    return false;
  }
  if (verdict.kind === "allowed") res.setHeader("access-control-allow-origin", verdict.origin);
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  // x-filename: the /fs/paste upload (image paste) sends it; without it the
  // cross-origin preflight from eos://app/ blocks the POST and paste fails.
  res.setHeader("access-control-allow-headers", "content-type, x-eos-ui-token, x-filename");
  // content-disposition: the export download reads the server-chosen filename
  // (orchestrator name + date) off this header; unexposed it's invisible to
  // cross-origin fetch and the UI falls back to the raw worker id.
  res.setHeader("access-control-expose-headers", "content-disposition");
  res.setHeader("access-control-max-age", "86400");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return false;
  }
  return true;
}
