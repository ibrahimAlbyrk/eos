import type { WorkerRow } from "../../../contracts/src/worker.ts";

export interface WorkerManagementClient {
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
