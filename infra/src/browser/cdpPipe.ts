// Raw CDP over Chrome's --remote-debugging-pipe: NUL-delimited JSON on the
// child's fd 3 (we write) / fd 4 (we read). No puppeteer/playwright — the
// framing is ~50 lines and the pipe never exposes an unauthenticated port
// (an open --remote-debugging-port is full-browser control for anything on
// the host). Modeled on the proven spike client (scratchpad spike-cdp/cdp.mjs),
// with the WebSocket transport swapped for the pipe.

import type { Readable, Writable } from "node:stream";

type CdpParams = Record<string, unknown>;
type EventListener = (params: CdpParams, sessionId: string | undefined) => void;

const DEFAULT_TIMEOUT_MS = 30_000;

export class CdpPipeClient {
  private toChrome: Writable;
  private id = 0;
  private pending = new Map<number, { resolve: (r: CdpParams) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Set<EventListener>>();
  private chunks: Buffer[] = [];
  private closed = false;
  private closeCbs: Array<() => void> = [];

  constructor(toChrome: Writable, fromChrome: Readable) {
    this.toChrome = toChrome;
    fromChrome.on("data", (chunk: Buffer) => this.onData(chunk));
    const onEnd = (): void => this.markClosed();
    fromChrome.on("end", onEnd);
    fromChrome.on("close", onEnd);
    fromChrome.on("error", onEnd);
    toChrome.on("error", () => this.markClosed());
  }

  send(method: string, params: CdpParams = {}, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CdpParams> {
    if (this.closed) return Promise.reject(new Error(`CDP pipe closed: ${method}`));
    const id = ++this.id;
    const payload: CdpParams = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.toChrome.write(JSON.stringify(payload) + "\0");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  on(method: string, fn: EventListener): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeCbs.push(fn);
  }

  isClosed(): boolean {
    return this.closed;
  }

  // NUL-delimited framing. Frames carry base64 JPEG payloads (hundreds of KB),
  // so partial chunks are the norm: accumulate until a 0x00 shows up, then
  // concat exactly once per complete frame.
  private onData(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const nul = chunk.indexOf(0, start);
      if (nul === -1) {
        if (start < chunk.length) this.chunks.push(chunk.subarray(start));
        return;
      }
      const parts = this.chunks;
      this.chunks = [];
      parts.push(chunk.subarray(start, nul));
      this.dispatch(Buffer.concat(parts).toString("utf8"));
      start = nul + 1;
    }
  }

  private dispatch(raw: string): void {
    let msg: { id?: number; result?: CdpParams; error?: { code: number; message: string }; method?: string; params?: CdpParams; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // a torn frame after a crash — nothing to route it to
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    const set = this.listeners.get(msg.method);
    if (set) for (const fn of set) fn(msg.params ?? {}, msg.sessionId);
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("CDP pipe closed"));
    }
    this.pending.clear();
    for (const fn of this.closeCbs) fn();
    this.closeCbs = [];
  }
}
