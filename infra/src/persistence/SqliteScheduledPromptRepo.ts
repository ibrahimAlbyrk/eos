// SqliteScheduledPromptRepo — scheduled_prompts table. Mirrors the other repos:
// prepared statements cached on the instance, a snake_case↔domain mapper, and
// safeStringify for the meta JSON column. A malformed/legacy meta decodes to
// null rather than throwing.

import type { DatabaseSync } from "node:sqlite";
import type {
  ScheduledPromptRepo,
  ScheduledPromptRow,
  InsertScheduledPrompt,
} from "../../../core/src/ports/ScheduledPromptRepo.ts";
import type { ScheduledPromptStatus } from "../../../contracts/src/http.ts";
import { safeStringify } from "../util/json.ts";

type Row = Record<string, unknown>;

function decodeMeta(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toRow(r: Row): ScheduledPromptRow {
  return {
    id: r.id as string,
    workerId: r.worker_id as string,
    text: r.text as string,
    fireAt: r.fire_at as number,
    status: r.status as ScheduledPromptStatus,
    createdAt: r.created_at as number,
    firedAt: (r.fired_at as number | null) ?? null,
    meta: decodeMeta(r.meta),
  };
}

export class SqliteScheduledPromptRepo implements ScheduledPromptRepo {
  private readonly stmtInsert;
  private readonly stmtFindById;
  private readonly stmtListByWorker;
  private readonly stmtListDue;
  private readonly stmtMarkFired;
  private readonly stmtCancel;

  constructor(db: DatabaseSync) {
    this.stmtInsert = db.prepare(
      "INSERT INTO scheduled_prompts (id, worker_id, text, fire_at, status, created_at, fired_at, meta) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL)",
    );
    this.stmtFindById = db.prepare("SELECT * FROM scheduled_prompts WHERE id = ?");
    this.stmtListByWorker = db.prepare(
      "SELECT * FROM scheduled_prompts WHERE worker_id = ? ORDER BY fire_at ASC, id ASC",
    );
    this.stmtListDue = db.prepare(
      "SELECT * FROM scheduled_prompts WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC, id ASC",
    );
    this.stmtMarkFired = db.prepare(
      "UPDATE scheduled_prompts SET status = 'fired', fired_at = ?, meta = ? WHERE id = ?",
    );
    // Cancels ONLY a pending row — the WHERE clause is the guard, so cancelling a
    // fired/cancelled row is a 0-change no-op.
    this.stmtCancel = db.prepare(
      "UPDATE scheduled_prompts SET status = 'cancelled' WHERE id = ? AND status = 'pending'",
    );
  }

  insert(input: InsertScheduledPrompt): ScheduledPromptRow {
    this.stmtInsert.run(input.id, input.workerId, input.text, input.fireAt, input.createdAt);
    return {
      id: input.id,
      workerId: input.workerId,
      text: input.text,
      fireAt: input.fireAt,
      status: "pending",
      createdAt: input.createdAt,
      firedAt: null,
      meta: null,
    };
  }

  findById(id: string): ScheduledPromptRow | null {
    const r = this.stmtFindById.get(id) as Row | undefined;
    return r ? toRow(r) : null;
  }

  listByWorker(workerId: string): ScheduledPromptRow[] {
    return (this.stmtListByWorker.all(workerId) as Row[]).map(toRow);
  }

  listDue(now: number): ScheduledPromptRow[] {
    return (this.stmtListDue.all(now) as Row[]).map(toRow);
  }

  markFired(id: string, firedAt: number, meta: Record<string, unknown> | null): void {
    this.stmtMarkFired.run(firedAt, meta === null ? null : safeStringify(meta), id);
  }

  cancel(id: string): boolean {
    return this.stmtCancel.run(id).changes > 0;
  }
}
