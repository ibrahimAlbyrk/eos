// SqliteTransferRepo — the transfers table (migration 062), one JSON row per
// transfer, re-validated on read.

import type { DatabaseSync } from "node:sqlite";
import { TransferRecordSchema, type TransferRecord } from "../../../contracts/src/transfer.ts";
import type { TransferRepo } from "../../../core/src/ports/TransferRepo.ts";

export class SqliteTransferRepo implements TransferRepo {
  private readonly stmtSave;
  private readonly stmtGet;
  private readonly stmtList;
  private readonly stmtRemove;

  constructor(db: DatabaseSync) {
    this.stmtSave = db.prepare(
      "INSERT INTO transfers (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    );
    this.stmtGet = db.prepare("SELECT data FROM transfers WHERE id = ?");
    this.stmtList = db.prepare("SELECT data FROM transfers ORDER BY created_at DESC LIMIT ?");
    this.stmtRemove = db.prepare("DELETE FROM transfers WHERE id = ?");
  }

  save(t: TransferRecord): void {
    this.stmtSave.run(t.id, t.createdAt, JSON.stringify(t));
  }

  get(id: string): TransferRecord | null {
    return parse(this.stmtGet.get(id));
  }

  list(limit: number): TransferRecord[] {
    return this.stmtList.all(limit).map(parse).filter((t): t is TransferRecord => t !== null);
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) this.stmtRemove.run(id);
  }
}

function parse(row: unknown): TransferRecord | null {
  if (!row || typeof row !== "object") return null;
  try {
    const r = TransferRecordSchema.safeParse(JSON.parse(String((row as { data: unknown }).data)));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
