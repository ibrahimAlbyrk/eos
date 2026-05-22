// PendingRepo — pending permission requests waiting for human resolution.

import type { PendingPermissionRow } from "../../../contracts/src/worker.ts";

export interface InsertPendingInput {
  id: string;
  workerId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string | null;
  createdAt: number;
  expiresAt: number;
}

export interface ResolvePendingInput {
  id: string;
  decision: "allow" | "deny";
  reason: string | null;
  updatedInput: Record<string, unknown> | null;
}

export interface PendingRepo {
  insert(input: InsertPendingInput): void;
  findById(id: string): PendingPermissionRow | null;
  listUnresolved(): PendingPermissionRow[];
  /** Returns true if a row was actually updated (false if already resolved). */
  resolve(input: ResolvePendingInput): boolean;
  /** Mark all expired (resolved=0 AND expires_at<now) as denied. Returns count. */
  sweepExpired(now: number, reason: string): number;
  deleteByWorker(workerId: string): void;
}
