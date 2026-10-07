// The host facade: `/h/<hostId>/<path>` on this daemon IS that host's daemon.
//
// A view that controls another computer points its API base at this prefix, so
// the renderer only ever talks to loopback — its CSP, <img>/<iframe> URLs and
// EventSource work exactly as for this Mac — while each request rides the
// secure link as one HTTP/2 stream. Bodies and responses stream both ways, so
// SSE and Range reads behave as they do locally; a dropped link ends the SSE
// response and the dashboard's reconnect resumes it from its last event id.

import http2 from "node:http2";
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { PEER_HUMAN_HEADER } from "../../contracts/src/peer.ts";
import { isPeerOpenRoute } from "../../contracts/src/route-planes.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { uiTokenOk } from "../routes/fs-shared.ts";
import { constantTimeEqual } from "../shared/constant-time.ts";
import type { Router, RouteHandler } from "../routes/Router.ts";
import { LinkUnavailableError, type HostLink } from "./HostLink.ts";

// How long a request waits for a (re)connecting link before failing: long
// enough to ride out a network switch, short enough that the UI can say so.
const READY_TIMEOUT_MS = 12_000;

const DROP_REQUEST = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
  "x-eos-ui-token", PEER_HUMAN_HEADER, "origin", "referer",
]);
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "trailer"]);

export const HOST_PREFIX = /^\/h\/(?<hostId>[0-9a-f]{64})(?<rest>\/.*)?$/;

// The app shell runs each controlled computer's dashboard in its own isolated
// view — possibly that computer's own UI bundle. Such a view never gets this
// Mac's ui-token (it would let that code drive THIS Mac); it gets a token that
// counts as "the human" only under its own host's /h/<id>/ prefix.
//
// Derived from this Mac's ui-token rather than stored: an open view keeps its
// token for the app's whole run, so it must still hold after the daemon restarts.
export class ViewTokens {
  private readonly secret: string;
  private readonly revoked = new Set<string>();

  constructor(secret: string) {
    this.secret = secret;
  }

  mint(hostId: string): string {
    this.revoked.delete(hostId);
    return this.derive(hostId);
  }

  validFor(token: unknown, hostId: string): boolean {
    if (typeof token !== "string" || this.revoked.has(hostId)) return false;
    return constantTimeEqual(token, this.derive(hostId));
  }

  revokeHost(hostId: string): void {
    this.revoked.add(hostId);
  }

  private derive(hostId: string): string {
    return createHmac("sha256", this.secret).update(`eos-view:${hostId}`).digest("hex");
  }
}

export async function forwardToHost(args: {
  link: HostLink;
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  human: boolean;
}): Promise<void> {
  const { link, req, res } = args;
  let session: http2.ClientHttp2Session;
  try {
    session = await link.ready(READY_TIMEOUT_MS);
  } catch (e) {
    const code = e instanceof LinkUnavailableError ? e.code : "unreachable";
    writeJson(res, 503, { error: "that computer is not reachable right now", code });
    return;
  }
  const method = req.method ?? "GET";
  const headers: http2.OutgoingHttpHeaders = { ":method": method, ":path": args.path };
  for (const [k, v] of Object.entries(req.headers)) {
    if (v !== undefined && !DROP_REQUEST.has(k)) headers[k] = v;
  }
  if (args.human) headers[PEER_HUMAN_HEADER] = "1";
  const hasBody = method !== "GET" && method !== "HEAD";

  let stream: http2.ClientHttp2Stream;
  try {
    stream = session.request(headers, { endStream: !hasBody });
  } catch {
    writeJson(res, 503, { error: "that computer is not reachable right now", code: "unreachable" });
    return;
  }
  stream.on("response", (h) => {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(h)) {
      if (!k.startsWith(":") && v !== undefined && !DROP_RESPONSE.has(k)) out[k] = v as string | string[];
    }
    res.writeHead(Number(h[":status"]) || 502, out);
    // Event streams must reach the renderer as they are written, not buffered.
    res.flushHeaders();
    stream.pipe(res);
  });
  stream.on("error", (e) => {
    if (!res.headersSent) writeJson(res, 502, { error: `link to that computer failed: ${e.message}`, code: "unreachable" });
    else res.destroy();
  });
  // The link dropped mid-response: end ours too, or the renderer waits forever.
  stream.on("close", () => { if (res.headersSent && !res.writableEnded) res.destroy(); });
  // The renderer went away (tab closed, SSE reconnect): cancel upstream.
  res.on("close", () => { if (!stream.closed && !stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL); });
  if (hasBody) req.pipe(stream);
}

// Mounts the facade on a router (the API server's and the raw server's). Must be
// registered before any route a /h/… path could shadow — it matches only /h/.
export function registerHostFacade(r: Router, deps: {
  link: (hostId: string) => HostLink | null;
  uiToken: string;
  viewTokens?: ViewTokens;
}): void {
  const handler: RouteHandler = async ({ req, res, params, url }) => {
    const link = deps.link(params.hostId);
    if (!link) { writeJson(res, 404, { error: "unknown computer", code: "unknown-host" }); return; }
    const rest = params.rest || "/";
    // Pairing and tunnels belong to the link itself — no caller here may speak them.
    if (rest.startsWith("/peer/")) { writeJson(res, 404, { error: "not an API route" }); return; }
    const human = uiTokenOk(req, deps.uiToken) || (deps.viewTokens?.validFor(req.headers["x-eos-ui-token"], params.hostId) ?? false);
    // Any process on this Mac can reach loopback; only the user's dashboard may
    // act on another computer through it.
    if (!human && !isPeerOpenRoute(req.method ?? "GET", rest)) {
      writeJson(res, 403, { error: "only the Eos window can do this on another computer", code: "needs-human" });
      return;
    }
    await forwardToHost({ link, req, res, path: rest + url.search, human });
  };
  for (const method of ["GET", "POST", "PUT", "DELETE", "HEAD"]) r.on(method, HOST_PREFIX, handler);
}
