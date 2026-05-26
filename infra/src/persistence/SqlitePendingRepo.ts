// SqlitePendingRepo — pending permission requests waiting for human approval.

import type { DatabaseSync } from "node:sqlite";
import type { PendingPermissionRow } from "../../../contracts/src/worker.ts";
import type { PendingRepo, InsertPendingInput, ResolvePendingInput } from "../../../core/src/ports/PendingRepo.ts";
import { withTransaction } from "./transaction.ts";
import { safeStringify } from "../util/json.ts";

export class SqlitePendingRepo implements PendingRepo {
  private readonly db: DatabaseSync;
  private readonly stmtInsert;
  private readonly stmtFindById;
  private readonly stmtListUnresolved;
  private readonly stmtResolve;
  private readonly stmtSweep;
  private readonly stmtDeleteByWorker;
  private readonly stmtSelectStale;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.stmtInsert = db.prepare(`
      INSERT INTO pending_permissions (id, worker_id, tool_name, input, tool_use_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtFindById = db.prepare("SELECT * FROM pending_permissions WHERE id = ?");
    this.stmtListUnresolved = db.prepare(`
      SELECT id, worker_id, tool_name, input, created_at, expires_at, resolved, decision, reason
      FROM pending_permissions WHERE resolved = 0 ORDER BY created_at ASC
    `);
    this.stmtResolve = db.prepare(
      "UPDATE pending_permissions SET resolved=1, decision=?, reason=?, updated_input=? WHERE id=? AND resolved=0",
    );
    this.stmtSweep = db.prepare(
      "UPDATE pending_permissions SET resolved = 1, decision = 'deny', reason = ? WHERE id = ?",
    );
    this.stmtSelectStale = db.prepare(
      "SELECT id FROM pending_permissions WHERE resolved = 0 AND expires_at < ?",
    );
    this.stmtDeleteByWorker = db.prepare("DELETE FROM pending_permissions WHERE worker_id = ?");
  }

  insert(input: InsertPendingInput): void {
    this.stmtInsert.run(
      input.id,
      input.workerId,
      input.toolName,
      safeStringify(input.input),
      input.toolUseId,
      input.createdAt,
      input.expiresAt,
    );
  }

  findById(id: string): PendingPermissionRow | null {
    const row = this.stmtFindById.get(id) as PendingPermissionRow | undefined;
    return row ?? null;
  }

  listUnresolved(): PendingPermissionRow[] {
    return this.stmtListUnresolved.all() as PendingPermissionRow[];
  }

  resolve(input: ResolvePendingInput): boolean {
    const updatedInput = input.updatedInput ? safeStringify(input.updatedInput) : null;
    const info = this.stmtResolve.run(input.decision, input.reason, updatedInput, input.id);
    return Number(info.changes) > 0;
  }

  sweepExpired(now: number, reason: string): number {
    return withTransaction(this.db, () => {
      const stale = this.stmtSelectStale.all(now) as Array<{ id: string }>;
      for (const r of stale) this.stmtSweep.run(reason, r.id);
      return stale.length;
    });
  }

  deleteByWorker(workerId: string): void {
    this.stmtDeleteByWorker.run(workerId);
  }
}
