// HttpWorkerClient — daemon → worker outbound. Worker exposes its
// /message endpoint on 127.0.0.1:<port>; this adapter hits it.

import type { WorkerClient } from "../../../core/src/ports/WorkerClient.ts";

export const httpWorkerClient: WorkerClient = {
  async sendMessage(port: number, text: string): Promise<{ ok: boolean; status: number; body: unknown }> {
    const r = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    let body: unknown = null;
    try { body = await r.json(); } catch { /* worker might not return JSON */ }
    return { ok: r.ok, status: r.status, body };
  },
};
