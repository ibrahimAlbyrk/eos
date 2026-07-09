// Control-dispatch shim (§5.2.3). A client control{method,path,body} (plaintext
// inner frame) is tier-classified, ui-token-gated, then dispatched into the
// EXISTING route handlers via an injected virtual-response dispatcher.
//
// v3 note: there is no per-action step-up and no reduced-capability session — the
// relay `join` bearer is the whole auth step, and every joined device is
// dispatched at full capability. HIGH-tier routes are therefore dispatched for
// any joined session; the meaningful gates that remain are REFUSED (never exposed
// remotely) + the ✦ ui-token gate.

import { classifyTier } from "./tiers.ts";
import { MAX_ENVELOPE_BYTES } from "./envelope.ts";
import type { RemoteAuditLog } from "./audit.ts";
import type { AssetFrame, ControlFrame, RemoteErrorCode } from "../../contracts/src/remote.ts";

// A dispatched route returns EITHER a JSON body (the default control plane) OR
// raw binary bytes + mime (a non-JSON asset route — image/pdf/raw/html/js). The
// binary arm keeps the bytes out of any utf-8 round-trip so they reach the device
// intact (design §4 / C6).
export type RouteDispatchResult =
  | { status: number; body: unknown }
  | { status: number; binary: { mime: string; bytes: Buffer } };

// Dispatch into the real route layer. `uiToken` is supplied only for ✦ routes the
// device is entitled to (it holds the "mutate" capability — §4.5).
export interface RouteDispatch {
  (input: { method: string; path: string; body: unknown; uiToken?: string }): Promise<RouteDispatchResult>;
}

// Headroom reserved above the asset frame's JSON plaintext for the outer envelope
// header (13 + roomLen≤255 + clientId 16). 512 covers the worst case so the framed
// envelope cannot exceed the relay's §4.4 limit.
const ASSET_FRAME_OVERHEAD = 512;

export interface DispatchSession {
  devId: string;
  hasCap(cap: string): boolean;
}

export interface DispatcherDeps {
  routeDispatch: RouteDispatch;
  audit: RemoteAuditLog;
  uiToken: string;
  now: () => number;
}

export type ServerReplyFrame =
  | { t: "reply"; correlationId: string; status: number; body: unknown }
  | AssetFrame
  | { t: "error"; code: RemoteErrorCode; message: string; correlationId: string };

export class ControlDispatcher {
  private readonly deps: DispatcherDeps;
  constructor(deps: DispatcherDeps) { this.deps = deps; }

  async handle(session: DispatchSession, frame: ControlFrame): Promise<ServerReplyFrame> {
    const { method, path, correlationId } = frame;

    const { tier, uiToken } = classifyTier(method, path);
    if (tier === "REFUSED") return this.deny(session, frame, "ROUTE_REFUSED", "route not exposed remotely");

    // ✦ routes need the local ui-token, supplied only to a session that holds the
    // "mutate" capability (every joined device does in v3 — there is no step-up).
    if (uiToken && !session.hasCap("mutate")) {
      return this.deny(session, frame, "CAP_DENIED", "device lacks the mutate capability");
    }

    // body is an opaque JSON string on the wire (§5.2.3). GET ⇒ "{}".
    const bodyStr = frame.body ?? "{}";
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(bodyStr); } catch { return this.deny(session, frame, "INTERNAL", "control body is not valid JSON"); }
    const suppliedToken = uiToken && session.hasCap("mutate") ? this.deps.uiToken : undefined;
    const result = await this.deps.routeDispatch({ method, path, body: parsedBody, uiToken: suppliedToken });
    this.audit(session, frame, result.status >= 400 ? (result.status === 403 ? "denied" : "error") : "ok");
    if ("binary" in result) return this.assetFrame(correlationId, result.status, result.binary);
    return { t: "reply", correlationId, status: result.status, body: result.body };
  }

  // Frame a non-JSON route read as an out-of-band asset (base64). Oversize fails
  // closed with a typed FRAME_TOO_LARGE error — the frozen asset shape is a single
  // frame with no chunk index, so a payload that won't fit the envelope is never
  // silently truncated.
  private assetFrame(correlationId: string, status: number, binary: { mime: string; bytes: Buffer }): ServerReplyFrame {
    const frame: AssetFrame = { t: "asset", correlationId, status, mime: binary.mime, bytesB64: binary.bytes.toString("base64") };
    if (Buffer.byteLength(JSON.stringify(frame), "utf8") + ASSET_FRAME_OVERHEAD > MAX_ENVELOPE_BYTES) {
      return { t: "error", code: "FRAME_TOO_LARGE", message: "asset exceeds relay envelope limit", correlationId };
    }
    return frame;
  }

  private deny(session: DispatchSession, frame: ControlFrame, code: RemoteErrorCode, message: string): ServerReplyFrame {
    this.audit(session, frame, "denied");
    return { t: "error", code, message, correlationId: frame.correlationId };
  }

  private audit(session: DispatchSession, frame: ControlFrame, result: "ok" | "denied" | "error"): void {
    this.deps.audit.append({
      device: session.devId,
      action: `${frame.method} ${frame.path}`,
      target: frame.path,
      ts: this.deps.now(),
      result,
    });
  }
}
