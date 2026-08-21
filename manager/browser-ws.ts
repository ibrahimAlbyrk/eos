// /browser/stream — the dedicated binary frame WebSocket (plan §3.3). One
// socket per open panel: JPEG frames ride downstream behind a 16-byte header,
// JSON control (subscribe/ack/pause/resume/input) rides upstream. Frames NEVER
// travel over SSE. Backpressure DROPS frames instead of queueing them — the
// screencast is damage-driven, so the next repaint supersedes anything queued.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { BrowserInputEvent, DisplaySize } from "../core/src/ports/BrowserEngine.ts";
import { BrowserService, BrowserDisabledError, DISPLAY_DEFAULTS } from "./services/BrowserService.ts";

// A control message reports the panel's live size so the daemon streams the
// RESPONSIVE tab 1:1 (native px) and emulates its viewport to match. Missing or
// junk values fall back to the safe default rather than a broken 0-sized stream.
function isPos(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}
export function displayFrom(msg: { cssWidth?: number; cssHeight?: number; dpr?: number }): DisplaySize {
  if (isPos(msg.cssWidth) && isPos(msg.cssHeight) && isPos(msg.dpr)) {
    return { cssWidth: msg.cssWidth, cssHeight: msg.cssHeight, dpr: msg.dpr };
  }
  return { ...DISPLAY_DEFAULTS };
}

export const BROWSER_STREAM_PATH = "/browser/stream";
export const FRAME_HEADER_BYTES = 16;
// CDP's own max_frames_in_flight is 3 — mirror it for the panel leg.
export const MAX_UNACKED_FRAMES = 3;
// ~4 frames at the q60/1024 measured ~230KB/frame: past this the socket is
// already behind a full compositor beat.
export const BACKPRESSURE_BYTES = 1_000_000;

// fnv1a-32 of the tabId — lets the client route a binary frame without JSON.
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 16-byte little-endian header: u32 tabKey · u32 seq · u16 width · u16 height ·
// u32 reserved(0). width/height = the JPEG bitmap's device px.
export function encodeFrameHeader(h: { tabKey: number; seq: number; width: number; height: number }): Buffer {
  const buf = Buffer.alloc(FRAME_HEADER_BYTES);
  buf.writeUInt32LE(h.tabKey >>> 0, 0);
  buf.writeUInt32LE(h.seq >>> 0, 4);
  buf.writeUInt16LE(h.width, 8);
  buf.writeUInt16LE(h.height, 10);
  return buf;
}

export function decodeFrameHeader(buf: Buffer): { tabKey: number; seq: number; width: number; height: number } {
  return {
    tabKey: buf.readUInt32LE(0),
    seq: buf.readUInt32LE(4),
    width: buf.readUInt16LE(8),
    height: buf.readUInt16LE(10),
  };
}

// The drop rule (§3.3): drop when the socket buffer is over the byte threshold
// OR the client is ≥ MAX_UNACKED_FRAMES behind on acks. Never queue.
export function shouldDropFrame(s: { bufferedAmount: number; sentSeq: number; ackedSeq: number }): boolean {
  return s.bufferedAmount > BACKPRESSURE_BYTES || s.sentSeq - s.ackedSeq >= MAX_UNACKED_FRAMES;
}

interface Log {
  warn(msg: string, meta?: Record<string, unknown>): void;
}

// Optional counter sink so a harness (or a future metrics route) can read the
// pump's real throughput; the daemon passes none.
export interface FramePumpStats {
  received: number;
  sent: number;
  dropped: number;
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function makeBrowserUpgradeHandler(deps: {
  browser: BrowserService;
  uiToken: string;
  log: Log;
  stats?: FramePumpStats;
}): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws: WebSocket) => attach(ws, deps));
  return (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== BROWSER_STREAM_PATH) {
      socket.destroy();
      return;
    }
    // Loopback + ui-token: same two locks as the REST surface. The token rides
    // the query string because a browser cannot set WS handshake headers.
    if (!isLoopback(req.socket.remoteAddress) || url.searchParams.get("uiToken") !== deps.uiToken) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  };
}

function attach(ws: WebSocket, deps: { browser: BrowserService; uiToken: string; log: Log; stats?: FramePumpStats }): void {
  const { browser, log, stats } = deps;
  let tabId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let sentSeq = 0;
  let ackedSeq = 0;
  // The panel's last-reported display size — reused on resume so a paused/hidden
  // panel comes back at the same resolution it left.
  let lastDisplay: DisplaySize = { ...DISPLAY_DEFAULTS };

  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };

  const onFrame = (frame: { tabId: string; data: Uint8Array; width: number; height: number }): void => {
    if (stats) stats.received++;
    if (ws.readyState !== ws.OPEN) return;
    if (shouldDropFrame({ bufferedAmount: ws.bufferedAmount, sentSeq, ackedSeq })) {
      if (stats) stats.dropped++;
      return;
    }
    sentSeq++;
    const header = encodeFrameHeader({ tabKey: fnv1a(frame.tabId), seq: sentSeq, width: frame.width, height: frame.height });
    ws.send(Buffer.concat([header, frame.data]), { binary: true });
    if (stats) stats.sent++;
  };

  const subscribe = async (msg: { tabId: string; display: DisplaySize }): Promise<void> => {
    stop();
    tabId = msg.tabId;
    lastDisplay = msg.display;
    unsubscribe = await browser.subscribeFrames(msg.tabId, msg.display, onFrame);
    // Control ack carrying the viewport CSS size — what the client needs for
    // canvas→page coordinate translation (§3.4's zoom denominator). Per-tab:
    // device emulation AND a responsive resize change it, so it is re-sent on
    // resize too.
    ws.send(JSON.stringify({ type: "subscribed", tabId: msg.tabId, viewport: browser.viewport(msg.tabId) }));
  };

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return; // upstream is JSON-only
    let msg: { type?: string; tabId?: string; cssWidth?: number; cssHeight?: number; dpr?: number; seq?: number; event?: BrowserInputEvent };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    switch (msg.type) {
      case "subscribe":
        if (typeof msg.tabId !== "string") return;
        void subscribe({ tabId: msg.tabId, display: displayFrom(msg) }).catch((e) => {
          const disabled = e instanceof BrowserDisabledError;
          if (!disabled) log.warn("browser stream subscribe failed", { tabId: msg.tabId, error: e instanceof Error ? e.message : String(e) });
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "error", message: e instanceof Error ? e.message : String(e) }));
        });
        return;
      case "resize":
        // The panel changed size — re-emulate the RESPONSIVE viewport and
        // restart the stream at the new native resolution (fixed profiles ignore
        // it), then re-send the viewport so canvas→page mapping stays exact.
        if (!tabId) return;
        lastDisplay = displayFrom(msg);
        void browser.resizeViewport(tabId, lastDisplay)
          .then(() => { if (ws.readyState === ws.OPEN && tabId) ws.send(JSON.stringify({ type: "subscribed", tabId, viewport: browser.viewport(tabId) })); })
          .catch((e) => log.warn("browser stream resize failed", { tabId, error: e instanceof Error ? e.message : String(e) }));
        return;
      case "unsubscribe":
      case "pause":
        // pause = Page.stopScreencast for this tab (last-subscriber refcount in
        // the service) → 0 bytes, ~0 CPU while the panel is hidden.
        stop();
        return;
      case "resume":
        if (tabId) {
          void subscribe({ tabId, display: lastDisplay }).catch((e) => {
            log.warn("browser stream resume failed", { tabId, error: e instanceof Error ? e.message : String(e) });
          });
        }
        return;
      case "ack":
        if (typeof msg.seq === "number" && msg.seq > ackedSeq) ackedSeq = msg.seq;
        return;
      case "input":
        if (tabId && msg.event) {
          void browser.input(tabId, msg.event).catch((e) => {
            log.warn("browser input dispatch failed", { tabId, error: e instanceof Error ? e.message : String(e) });
          });
        }
        return;
      default:
        return;
    }
  });

  ws.on("close", stop);
  ws.on("error", stop);
}
