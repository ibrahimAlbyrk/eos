// DaemonClient — worker / gateway / orchestrator-mcp → daemon outbound port.
// Adapter is HttpDaemonClient in infra/ipc/.

import type { WorkerEventType } from "../../../contracts/src/events.ts";
import type { ExternalDecision } from "../../../contracts/src/policy.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

export interface DaemonClient {
  pushEvent(workerId: string, type: WorkerEventType | string, payload: unknown): Promise<void>;
  decidePolicy(input: {
    workerId: string;
    toolName: string;
    input: Record<string, unknown>;
    toolUseId?: string | null;
  }): Promise<ExternalDecision>;
  getWorker(id: string): Promise<WorkerRow | null>;
  spawnWorker(spec: {
    prompt: string;
    cwd?: string;
    worktreeFrom?: string;
    branch?: string;
    name?: string;
    withGateway?: boolean;
    model?: string;
    parentId?: string;
  }): Promise<{ id: string; port: number }>;
  killWorker(id: string): Promise<{ ok: boolean }>;
  listWorkers(): Promise<WorkerRow[]>;
  listPending(): Promise<Array<{ id: string; worker_id: string; tool_name: string; input: string; expires_at: number }>>;
}
