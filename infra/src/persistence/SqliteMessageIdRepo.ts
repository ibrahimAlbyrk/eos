// SqliteMessageIdRepo — worker_message_ids table (one counter row per worker).
// An inbound id bumps seq and restarts sub; an assistant id bumps sub under the
// current seq. node:sqlite is synchronous, so each upsert + read pair is atomic
// within the daemon.

import type { DatabaseSync } from "node:sqlite";
import type { MessageIdRepo } from "../../../core/src/ports/MessageIdRepo.ts";

export class SqliteMessageIdRepo implements MessageIdRepo {
  private readonly stmtBumpSeq;
  private readonly stmtBumpSub;
  private readonly stmtGet;
  private readonly stmtDelete;

  constructor(db: DatabaseSync) {
    this.stmtBumpSeq = db.prepare(
      "INSERT INTO worker_message_ids (worker_id, seq, sub) VALUES (?, 1, 0) ON CONFLICT(worker_id) DO UPDATE SET seq = seq + 1, sub = 0",
    );
    this.stmtBumpSub = db.prepare(
      "INSERT INTO worker_message_ids (worker_id, seq, sub) VALUES (?, 0, 1) ON CONFLICT(worker_id) DO UPDATE SET sub = sub + 1",
    );
    this.stmtGet = db.prepare("SELECT seq, sub FROM worker_message_ids WHERE worker_id = ?");
    this.stmtDelete = db.prepare("DELETE FROM worker_message_ids WHERE worker_id = ?");
  }

  nextInbound(workerId: string): number {
    this.stmtBumpSeq.run(workerId);
    return this.read(workerId).seq;
  }

  nextAssistant(workerId: string): string {
    this.stmtBumpSub.run(workerId);
    const { seq, sub } = this.read(workerId);
    return `${seq}.${sub}`;
  }

  deleteByWorker(workerId: string): void {
    this.stmtDelete.run(workerId);
  }

  private read(workerId: string): { seq: number; sub: number } {
    return this.stmtGet.get(workerId) as { seq: number; sub: number };
  }
}
