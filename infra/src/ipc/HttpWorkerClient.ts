// HttpWorkerClient — daemon → worker outbound. Worker exposes its
// /message endpoint on 127.0.0.1:<port>; this adapter hits it.

import type { WorkerClient } from "../../../core/src/ports/WorkerClient.ts";

export interface HttpWorkerClientOptions {
  sendTimeoutMs?: number;
  interruptTimeoutMs?: number;
}

export function createHttpWorkerClient(opts: HttpWorkerClientOptions = {}): WorkerClient {
  const sendTimeout = opts.sendTimeoutMs ?? 30_000;
  const interruptTimeout = opts.interruptTimeoutMs ?? 5_000;

  return {
    async sendInterrupt(port: number): Promise<{ ok: boolean; reason?: string }> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), interruptTimeout);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/interrupt`, {
          method: "POST",
          signal: ac.signal,
        });
        const body = await r.json().catch(() => ({})) as { ok?: boolean; reason?: string };
        return { ok: !!body.ok, reason: body.reason };
      } catch {
        return { ok: false };
      } finally {
        clearTimeout(timer);
      }
    },

    async sendMessage(port: number, text: string): Promise<{ ok: boolean; status: number; body: unknown }> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), sendTimeout);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: ac.signal,
        });
        let body: unknown = null;
        try { body = await r.json(); } catch { /* worker might not return JSON */ }
        return { ok: r.ok, status: r.status, body };
      } catch {
        return { ok: false, status: 0, body: null };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const httpWorkerClient: WorkerClient = createHttpWorkerClient();
