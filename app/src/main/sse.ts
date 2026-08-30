// Main-process SSE reader for the daemon /stream. One shared reader dispatches
// both the tray's fleet feed (reason "worker:*") and notifications
// (reason "notification:fire"), with the same exponential-backoff reconnect
// discipline the UI's sse.js uses (doc 20 §b, plan §E3 R15). A Node fetch-stream
// parser — Node has no browser EventSource reconnect semantics.

export interface SSEHandlers {
  onEvent: (reason: string, payload: unknown) => void;
  onConnectivity: (up: boolean) => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SSEClient {
  private stopped = false;
  private backoff = 1000;

  constructor(private readonly url: string, private readonly token: string, private readonly h: SSEHandlers) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(this.url, {
          headers: { accept: "text/event-stream", "x-eos-ui-token": this.token },
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        this.h.onConnectivity(true);
        this.backoff = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!this.stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            this.handleLine(buf.slice(0, nl).trim());
            buf = buf.slice(nl + 1);
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      if (this.stopped) break;
      this.h.onConnectivity(false);
      await delay(this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    }
  }

  // Cheap substring guard before JSON.parse, mirroring the Swift raw-substring
  // test — most frames (thinking deltas etc.) are skipped without allocation.
  private handleLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const json = line.slice(5).trim();
    if (!json || (!json.includes("worker:") && !json.includes("notification:fire"))) return;
    try {
      const obj = JSON.parse(json) as { reason?: unknown; payload?: unknown };
      if (typeof obj.reason === "string") this.h.onEvent(obj.reason, obj.payload);
    } catch {
      /* partial/non-JSON frame */
    }
  }
}
