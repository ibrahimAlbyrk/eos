import type { DatabaseSync } from "node:sqlite";

let inTransaction = false;

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (inTransaction) return fn();
  inTransaction = true;
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    inTransaction = false;
  }
}
