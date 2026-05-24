import type { WorkerEventType } from "../../../contracts/src/events.ts";

export interface WorkerEventClient {
  pushEvent(workerId: string, type: WorkerEventType | string, payload: unknown): Promise<void>;
}
