import { daemonApi } from "../shared/http.ts";

export interface WorkerSession {
  readonly selfId: string;
  readonly daemonUrl: string;
  // Spawned with collaborate=true → the peer tools are registered. Set by the
  // daemon as EOS_COLLABORATE on the worker MCP child's env (container.ts), so
  // it's known synchronously at boot with no daemon round-trip.
  readonly collaborate: boolean;
  // The DPI role (EOS_ROLE) → selects the tool surface. "workflow-worker" gets
  // ONLY the workflow output tools; "" / absent ⇒ the general worker surface.
  readonly role: string;
  api(method: string, path: string, body?: unknown): Promise<unknown>;
}

export function resolveSession(): WorkerSession {
  const daemonUrl = process.env.EOS_DAEMON_URL ?? "http://127.0.0.1:7400";
  const selfId = process.env.EOS_WORKER_ID;
  if (!selfId) {
    process.stderr.write("[worker-mcp] FATAL: EOS_WORKER_ID not set\n");
    process.exit(1);
  }
  const collaborate = process.env.EOS_COLLABORATE === "1";
  const role = process.env.EOS_ROLE ?? "";
  const api = (method: string, path: string, body?: unknown): Promise<unknown> =>
    daemonApi(daemonUrl, method, path, body);
  return { selfId, daemonUrl, collaborate, role, api };
}
