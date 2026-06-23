// SqliteRuntimeWorkerDefinitionStore — worker_definitions table. Persists the
// orchestrator-created ("runtime") worker definitions so they survive a daemon
// restart (the in-memory predecessor dropped them on every boot). Mirrors the
// other repos: prepared statements cached on the instance, safeStringify for the
// JSON column, Date.now() for the audit columns (the port carries no clock).
//
// The FULL definition JSON is stored and re-validated on read (safeParse): a
// future WorkerDefinitionSchema bump that invalidates an old row makes that row
// silently disappear from listFor instead of crashing boot (mirrors the
// validate-on-read skip in FileWorkerDefinitionSource).

import type { DatabaseSync } from "node:sqlite";
import type { RuntimeWorkerDefinitionStore } from "../../../core/src/ports/RuntimeWorkerDefinitionStore.ts";
import {
  WorkerDefinitionSchema,
  type WorkerDefinition,
  type WorkerDefinitionRecord,
} from "../../../contracts/src/worker-definition.ts";
import { safeStringify } from "../util/json.ts";

type Row = Record<string, unknown>;

export class SqliteRuntimeWorkerDefinitionStore implements RuntimeWorkerDefinitionStore {
  private readonly stmtUpsert;
  private readonly stmtListByOwner;
  private readonly stmtDeleteByOwner;

  constructor(db: DatabaseSync) {
    // UPSERT on the (owner, name) primary key — a re-create overwrites, matching
    // the old Map.set semantics. created_at is preserved across overwrites.
    this.stmtUpsert = db.prepare(`
      INSERT INTO worker_definitions (owner, name, json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner, name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `);
    this.stmtListByOwner = db.prepare("SELECT json FROM worker_definitions WHERE owner = ?");
    this.stmtDeleteByOwner = db.prepare("DELETE FROM worker_definitions WHERE owner = ?");
  }

  create(ownerId: string, def: WorkerDefinition): void {
    const now = Date.now();
    this.stmtUpsert.run(ownerId, def.name, safeStringify(def), now, now);
  }

  listFor(ownerId: string): WorkerDefinitionRecord[] {
    const out: WorkerDefinitionRecord[] = [];
    for (const r of this.stmtListByOwner.all(ownerId) as Row[]) {
      if (typeof r.json !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.json);
      } catch {
        continue;
      }
      const res = WorkerDefinitionSchema.safeParse(parsed);
      if (!res.success) continue;
      out.push({ ...res.data, source: "runtime" as const });
    }
    return out;
  }

  deleteForOwner(ownerId: string): void {
    this.stmtDeleteByOwner.run(ownerId);
  }
}
