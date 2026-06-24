// SqliteRuntimeWorkflowDefinitionStore — workflow_definitions table. Persists the
// orchestrator-created ("runtime") workflow definitions so they survive a daemon
// restart. The workflow-system twin of SqliteRuntimeWorkerDefinitionStore: keyed
// by OWNER, prepared statements cached on the instance, safeStringify for the JSON
// column, Date.now() for the audit columns (the port carries no clock).
//
// The FULL definition JSON is stored and re-validated on read (safeParse): a
// future WorkflowDefinitionSchema bump that invalidates an old row makes that row
// silently disappear from listFor instead of crashing boot (mirrors the
// validate-on-read skip in FileWorkflowDefinitionSource).

import type { DatabaseSync } from "node:sqlite";
import type { RuntimeWorkflowDefinitionStore } from "../../../core/src/ports/RuntimeWorkflowDefinitionStore.ts";
import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowDefinitionRecord,
} from "../../../contracts/src/workflow.ts";
import { safeStringify } from "../util/json.ts";

type Row = Record<string, unknown>;

export class SqliteRuntimeWorkflowDefinitionStore implements RuntimeWorkflowDefinitionStore {
  private readonly stmtUpsert;
  private readonly stmtListByOwner;
  private readonly stmtDeleteByOwner;

  constructor(db: DatabaseSync) {
    // UPSERT on the (owner, name) primary key — a re-create overwrites, matching
    // the old Map.set semantics. created_at is preserved across overwrites.
    this.stmtUpsert = db.prepare(`
      INSERT INTO workflow_definitions (owner, name, json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(owner, name) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
    `);
    this.stmtListByOwner = db.prepare("SELECT json FROM workflow_definitions WHERE owner = ?");
    this.stmtDeleteByOwner = db.prepare("DELETE FROM workflow_definitions WHERE owner = ?");
  }

  create(ownerId: string, def: WorkflowDefinition): void {
    const now = Date.now();
    this.stmtUpsert.run(ownerId, def.name, safeStringify(def), now, now);
  }

  listFor(ownerId: string): WorkflowDefinitionRecord[] {
    const out: WorkflowDefinitionRecord[] = [];
    for (const r of this.stmtListByOwner.all(ownerId) as Row[]) {
      if (typeof r.json !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.json);
      } catch {
        continue;
      }
      const res = WorkflowDefinitionSchema.safeParse(parsed);
      if (!res.success) continue;
      out.push({ ...res.data, source: "runtime" as const });
    }
    return out;
  }

  deleteForOwner(ownerId: string): void {
    this.stmtDeleteByOwner.run(ownerId);
  }
}
