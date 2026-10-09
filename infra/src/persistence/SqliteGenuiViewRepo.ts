// SqliteGenuiViewRepo — the genui_views + genui_view_state tables (migration
// 064). The spec is one JSON column; rows are re-validated on read.

import type { DatabaseSync } from "node:sqlite";
import { ViewRecordSchema, ViewStateSchema, type ViewRecord, type ViewState } from "../../../contracts/src/genui/spec.ts";
import type { GenuiViewRepo, StoredViewState } from "../../../core/src/ports/GenuiViewRepo.ts";

interface ViewRow {
  id: string;
  worker_id: string;
  kind: string;
  title: string;
  data: string;
  created_at: number;
}

export class SqliteGenuiViewRepo implements GenuiViewRepo {
  private readonly stmtSave;
  private readonly stmtGet;
  private readonly stmtGetState;
  private readonly stmtPutState;
  private readonly stmtDropStates;
  private readonly stmtDropViews;

  constructor(db: DatabaseSync) {
    this.stmtSave = db.prepare(
      `INSERT INTO genui_views (id, worker_id, kind, title, data, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET worker_id = excluded.worker_id, kind = excluded.kind, title = excluded.title, data = excluded.data`,
    );
    this.stmtGet = db.prepare("SELECT id, worker_id, kind, title, data, created_at FROM genui_views WHERE id = ?");
    this.stmtGetState = db.prepare("SELECT data, updated_at FROM genui_view_state WHERE id = ?");
    this.stmtPutState = db.prepare(
      "INSERT INTO genui_view_state (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    );
    this.stmtDropStates = db.prepare("DELETE FROM genui_view_state WHERE id IN (SELECT id FROM genui_views WHERE worker_id = ?)");
    this.stmtDropViews = db.prepare("DELETE FROM genui_views WHERE worker_id = ?");
  }

  save(view: ViewRecord): void {
    this.stmtSave.run(view.id, view.workerId, view.kind, view.title, JSON.stringify(view.spec), view.createdAt);
  }

  get(id: string): ViewRecord | null {
    const row = this.stmtGet.get(id) as ViewRow | undefined;
    if (!row) return null;
    try {
      const r = ViewRecordSchema.safeParse({
        id: row.id,
        workerId: row.worker_id,
        kind: row.kind,
        title: row.title,
        createdAt: row.created_at,
        spec: JSON.parse(row.data),
      });
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }

  getState(id: string): StoredViewState | null {
    const row = this.stmtGetState.get(id) as { data: string; updated_at: number } | undefined;
    if (!row) return null;
    try {
      const r = ViewStateSchema.safeParse(JSON.parse(row.data));
      return r.success ? { state: r.data, updatedAt: row.updated_at } : null;
    } catch {
      return null;
    }
  }

  putState(id: string, state: ViewState, at: number): void {
    this.stmtPutState.run(id, JSON.stringify(state), at);
  }

  removeByWorker(workerId: string): void {
    this.stmtDropStates.run(workerId);
    this.stmtDropViews.run(workerId);
  }
}
