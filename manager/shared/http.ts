// Shared HTTP helper for talking to the daemon. Used by cli.ts and
// orchestrator-mcp.ts — each adds its own error policy on top.

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
 * @returns A {@link DaemonFetchResult} describing success/failure.
 */
export async function daemonFetch(
  daemonUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<DaemonFetchResult> {
  let res: Response;
  try {
    res = await fetch(`${daemonUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, status: 0, body: null, raw: "", networkError: e as Error };
  }
  const raw = await res.text();
  let parsed: unknown = raw;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { /* leave as string */ }
  } else {
    parsed = {};
  }
  // Treat 201 as success; the daemon returns 201 from POST /workers.
  const ok = res.ok || res.status === 201;
  return { ok, status: res.status, body: parsed, raw, networkError: null };
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
): Promise<unknown> {
  const r = await daemonFetch(daemonUrl, method, path, body);
  if (r.networkError) throw new Error(`daemon unreachable at ${daemonUrl}: ${r.networkError.message}`);
  if (!r.ok) throw new Error(`daemon ${r.status}: ${r.raw}`);
  return r.body;
}
