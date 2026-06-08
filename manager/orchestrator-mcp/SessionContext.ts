// Orchestrator-mcp session — encapsulates the per-orchestrator identity,
// daemon endpoint, and lazy git-repo probe. Was previously evaluated at
// module load (which made the file un-importable for tests and prone to
// fail-on-boot if the daemon hadn't started yet).

import { spawnSync } from "node:child_process";
import { daemonApi } from "../shared/http.ts";

export interface OrchestratorSession {
  readonly selfId: string;
  readonly daemonUrl: string;
  readonly cwd: string;
  readonly isGitRepo: boolean;
  api(method: string, path: string, body?: unknown): Promise<unknown>;
}

export async function resolveSession(): Promise<OrchestratorSession> {
  const daemonUrl = process.env.EOS_DAEMON_URL ?? "http://127.0.0.1:7400";
  const selfId = process.env.EOS_WORKER_ID ?? "orchestrator";
  const api = (method: string, path: string, body?: unknown): Promise<unknown> =>
    daemonApi(daemonUrl, method, path, body);

  const self = (await api("GET", `/workers/${selfId}`)) as { cwd?: string | null };
  const cwd = (self.cwd ?? "").trim();
  if (!cwd) {
    process.stderr.write(`[orchestrator-mcp] FATAL: self (${selfId}) has no cwd in daemon\n`);
    process.exit(1);
  }
  const gitCheck = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8" });
  const isGitRepo = gitCheck.status === 0;
  return { selfId, daemonUrl, cwd, isGitRepo, api };
}
