// HttpWorkerClient — daemon → worker outbound. Worker exposes its
// /message endpoint on 127.0.0.1:<port>; this adapter hits it.

import type { WorkerClient, RewindResult, MessageRecord } from "../../../core/src/ports/WorkerClient.ts";

export interface HttpWorkerClientOptions {
  sendTimeoutMs?: number;
  interruptTimeoutMs?: number;
  rewindTimeoutMs?: number;
}

export function createHttpWorkerClient(opts: HttpWorkerClientOptions = {}): WorkerClient {
  const sendTimeout = opts.sendTimeoutMs ?? 30_000;
  const interruptTimeout = opts.interruptTimeoutMs ?? 5_000;
  // Choreography scales with ↑-press count on long sessions — generous ceiling.
  const rewindTimeout = opts.rewindTimeoutMs ?? 60_000;

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

    async sendKeystroke(port: number, keys: string): Promise<{ ok: boolean }> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), interruptTimeout);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/keystroke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys }),
          signal: ac.signal,
        });
        return { ok: r.ok };
      } catch {
        return { ok: false };
      } finally {
        clearTimeout(timer);
      }
    },

    async getRewindTargets(port: number): Promise<{ targets: unknown[] }> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), interruptTimeout);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/rewind-targets`, {
          method: "POST",
          signal: ac.signal,
        });
        const body = await r.json().catch(() => ({})) as { targets?: unknown[] };
        return { targets: Array.isArray(body.targets) ? body.targets : [] };
      } catch {
        return { targets: [] };
      } finally {
        clearTimeout(timer);
      }
    },

    async sendRewind(port: number, body: { uuid: string; mode: string }): Promise<RewindResult> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), rewindTimeout);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/rewind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        const out = await r.json().catch(() => ({})) as RewindResult;
        return { ok: !!out.ok, uuid: out.uuid, text: out.text, display: out.display, index: out.index, error: out.error };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        clearTimeout(timer);
      }
    },

    async sendMessage(port: number, text: string, record?: MessageRecord): Promise<{ ok: boolean; status: number; body: unknown }> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), sendTimeout);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record ? { text, record } : { text }),
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
