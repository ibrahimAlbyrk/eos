import { daemonApi } from "../shared/http.ts";

export interface WorkerSession {
  readonly selfId: string;
  readonly daemonUrl: string;
  api(method: string, path: string, body?: unknown): Promise<unknown>;
}

export function resolveSession(): WorkerSession {
  const daemonUrl = process.env.CLAUDE_MGR_DAEMON_URL ?? "http://127.0.0.1:7400";
  const selfId = process.env.CLAUDE_MGR_WORKER_ID;
  if (!selfId) {
    process.stderr.write("[worker-mcp] FATAL: CLAUDE_MGR_WORKER_ID not set\n");
    process.exit(1);
  }
  const api = (method: string, path: string, body?: unknown): Promise<unknown> =>
    daemonApi(daemonUrl, method, path, body);
  return { selfId, daemonUrl, api };
}
