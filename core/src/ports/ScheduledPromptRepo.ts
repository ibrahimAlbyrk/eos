// ScheduledPromptRepo — prompts queued to fire into a worker's chat at a
// wall-clock instant. Adapter is SqliteScheduledPromptRepo. A row is born
// 'pending', transitions to 'fired' once the SchedulerService dispatches it, or
// to 'cancelled' when removed before firing.

import type { ScheduledPromptStatus } from "../../../contracts/src/http.ts";

export interface ScheduledPromptRow {
  id: string;
  workerId: string;
  text: string;
  fireAt: number;
  status: ScheduledPromptStatus;
  createdAt: number;
  firedAt: number | null;
  meta: Record<string, unknown> | null;
}

export interface InsertScheduledPrompt {
  id: string;
  workerId: string;
  text: string;
  fireAt: number;
  createdAt: number;
}

export interface ScheduledPromptRepo {
  /** Insert a 'pending' row and return it. */
  insert(input: InsertScheduledPrompt): ScheduledPromptRow;
  findById(id: string): ScheduledPromptRow | null;
  listByWorker(workerId: string): ScheduledPromptRow[];
  /** Pending rows whose fireAt has passed (fire_at <= now), oldest first. */
  listDue(now: number): ScheduledPromptRow[];
  markFired(id: string, firedAt: number, meta: Record<string, unknown> | null): void;
  /** Cancels ONLY a 'pending' row. Returns true if a row transitioned. */
  cancel(id: string): boolean;
}
