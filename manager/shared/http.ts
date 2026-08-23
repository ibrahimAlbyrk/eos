// Shared HTTP helper for talking to the daemon. Used by cli.ts and
// orchestrator-mcp.ts — each adds its own error policy on top.

import { Agent, request } from "node:http";

// Unix-socket transport, taken whenever the daemon exported EOS_DAEMON_SOCK into
// this process (CLI, MCP servers, spawned workers). A UDS call costs no ephemeral
// port, so daemon chatter can never saturate the local port range — the failure
// mode where every connect() on the machine dies with EADDRNOTAVAIL. Without the
// variable this stays on TCP `fetch` (pooled by undici).
const socketAgent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8 });

function socketRequest(
  socketPath: string,
  method: string,
  path: string,
  payload: string | null,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method,
        agent: socketAgent,
        headers: payload ? { ...headers, "content-length": Buffer.byteLength(payload) } : headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export interface DaemonFetchResult {
  ok: boolean;
  status: number;
  body: unknown;
  raw: string;
  networkError: Error | null;
}

/**
 * Low-level request wrapper. Never throws — wraps the network error and any
 * HTTP non-2xx response into a result tuple the caller can branch on. Use
 * this when you want to customize the error UX (CLI process.exit, MCP
 * structured error, etc).
 *
 * @param daemonUrl  Base daemon URL, e.g. http://127.0.0.1:7400
 * @param method     HTTP method.
 * @param path       Path including leading slash.
 * @param body       Optional JSON body. Headers + serialization handled here.
 * @param headers    Optional extra headers (e.g. x-eos-agent-id identity).
 * @returns A {@link DaemonFetchResult} describing success/failure.
 */
export async function daemonFetch(
  daemonUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<DaemonFetchResult> {
  const merged = { ...(body ? { "content-type": "application/json" } : {}), ...(headers ?? {}) };
  const payload = body === undefined ? null : JSON.stringify(body);
  const socketPath = process.env.EOS_DAEMON_SOCK;
  let status: number | null = null;
  let raw = "";
  try {
    // A socket file that is gone (daemon restarting) or unusable must not be a
    // hard failure while the TCP port is still there — try it, then fall back.
    if (socketPath) {
      const r = await socketRequest(socketPath, method, path, payload, merged).catch(() => null);
      if (r) { status = r.status; raw = r.text; }
    }
    if (status === null) {
      const res = await fetch(`${daemonUrl}${path}`, {
        method,
        headers: Object.keys(merged).length ? merged : undefined,
        body: payload ?? undefined,
      });
      status = res.status;
      raw = await res.text();
    }
  } catch (e) {
    return { ok: false, status: 0, body: null, raw: "", networkError: e as Error };
  }
  let parsed: unknown = raw;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { /* leave as string */ }
  } else {
    parsed = {};
  }
  // Treat 201 as success; the daemon returns 201 from POST /workers.
  const ok = status >= 200 && status < 300;
  return { ok, status, body: parsed, raw, networkError: null };
}

/**
 * Throwing variant of {@link daemonFetch} — rejects with a single Error on
 * either a network failure or any non-2xx response. Convenient when the
 * caller wants Promise rejection semantics rather than result-tuple branching
 * (e.g., async/await in MCP tool handlers).
 */
export async function daemonApi(
  daemonUrl: string,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<unknown> {
  const r = await daemonFetch(daemonUrl, method, path, body, headers);
  if (r.networkError) throw new Error(`daemon unreachable at ${daemonUrl}: ${r.networkError.message}`);
  if (!r.ok) throw new Error(`daemon ${r.status}: ${r.raw}`);
  return r.body;
}
