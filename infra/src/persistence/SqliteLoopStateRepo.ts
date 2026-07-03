// SqliteLoopStateRepo — worker_loops table. Mirrors the other repos: prepared
// statements cached on the instance, snake_case↔domain mapper, safeStringify for
// the JSON columns (goal_json, progress_ring). A fresh insert is always "active";
// mutations stamp updated_at here (the port carries no clock, like the message
// queue's audit columns).

import type { DatabaseSync } from "node:sqlite";
import type {
  LoopStateRepo,
  LoopRow,
  InsertLoopInput,
  LoopAmendPatch,
  LoopAttempt,
  StepHeldOutput,
} from "../../../core/src/ports/LoopStateRepo.ts";
import type { LoopStatus, LoopStrategy, GoalSpec } from "../../../contracts/src/loop.ts";
import { safeStringify } from "../util/json.ts";

type Row = Record<string, unknown>;

// Cap on the no-progress/oscillation fingerprint buffer — recent attempts only.
const PROGRESS_RING_CAP = 20;

function decodeRing(raw: unknown): LoopAttempt[] {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LoopAttempt[]) : [];
  } catch {
    return [];
  }
}

function decodeHeldOutput(raw: unknown): StepHeldOutput | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StepHeldOutput) : null;
  } catch {
    return null;
  }
}

function toLoopRow(r: Row): LoopRow {
  return {
    id: r.id as string,
    workerId: r.worker_id as string,
    parentId: (r.parent_id as string | null) ?? null,
    goal: JSON.parse(r.goal_json as string) as GoalSpec,
    strategy: r.strategy as LoopStrategy,
    status: r.status as LoopStatus,
    attempt: r.attempt as number,
    maxAttempts: (r.max_attempts as number | null) ?? null,
    heldReport: (r.held_report as string | null) ?? null,
    heldOutput: decodeHeldOutput(r.held_output),
    lastReason: (r.last_reason as string | null) ?? null,
    awaitingInput: ((r.awaiting_input as number | null) ?? 0) !== 0,
    checkFailures: (r.check_failures as number | null) ?? 0,
    progressRing: decodeRing(r.progress_ring),
    startedAt: r.started_at as number,
    updatedAt: r.updated_at as number,
  };
}

export class SqliteLoopStateRepo implements LoopStateRepo {
  private readonly stmtInsert;
  private readonly stmtFindById;
  private readonly stmtFindActiveByWorker;
  private readonly stmtFindAnyByWorker;
  private readonly stmtListActive;
  private readonly stmtSetStatus;
  private readonly stmtAmend;
  private readonly stmtResetProgress;
  private readonly stmtSetCheckFailures;
  private readonly stmtRecordAttempt;
  private readonly stmtSetHeldReport;
  private readonly stmtClearHeld;
  private readonly stmtSetHeldOutput;
  private readonly stmtSetAwaitingInput;
  private readonly stmtClear;
  private readonly stmtDeleteByWorker;

  constructor(db: DatabaseSync) {
    this.stmtInsert = db.prepare(`
      INSERT INTO worker_loops
        (id, worker_id, parent_id, goal_json, strategy, status, attempt, max_attempts, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)
    `);
    this.stmtFindById = db.prepare("SELECT * FROM worker_loops WHERE id = ?");
    this.stmtFindActiveByWorker = db.prepare(
      "SELECT * FROM worker_loops WHERE worker_id = ? AND status = 'active' LIMIT 1",
    );
    this.stmtFindAnyByWorker = db.prepare(
      "SELECT * FROM worker_loops WHERE worker_id = ? ORDER BY started_at DESC LIMIT 1",
    );
    this.stmtListActive = db.prepare("SELECT * FROM worker_loops WHERE status = 'active' ORDER BY started_at ASC");
    this.stmtSetStatus = db.prepare("UPDATE worker_loops SET status = ?, updated_at = ? WHERE id = ?");
    // Goal renegotiation writes all three amendable columns in one statement; the
    // repo reads the current row first and passes merged values (see amend()).
    this.stmtAmend = db.prepare(
      "UPDATE worker_loops SET goal_json = ?, strategy = ?, max_attempts = ?, updated_at = ? WHERE id = ?",
    );
    this.stmtResetProgress = db.prepare(
      "UPDATE worker_loops SET progress_ring = NULL, updated_at = ? WHERE id = ?",
    );
    this.stmtSetCheckFailures = db.prepare(
      "UPDATE worker_loops SET check_failures = ?, updated_at = ? WHERE id = ?",
    );
    this.stmtRecordAttempt = db.prepare(
      "UPDATE worker_loops SET attempt = attempt + 1, progress_ring = ?, last_reason = ?, updated_at = ? WHERE id = ?",
    );
    this.stmtSetHeldReport = db.prepare("UPDATE worker_loops SET held_report = ?, updated_at = ? WHERE id = ?");
    // Clearing the held report clears its structured twin too — they share a
    // lifecycle (set on hold, cleared on release/continue).
    this.stmtClearHeld = db.prepare("UPDATE worker_loops SET held_report = NULL, held_output = NULL, updated_at = ? WHERE id = ?");
    this.stmtSetHeldOutput = db.prepare("UPDATE worker_loops SET held_output = ?, updated_at = ? WHERE id = ?");
    this.stmtSetAwaitingInput = db.prepare("UPDATE worker_loops SET awaiting_input = ?, updated_at = ? WHERE id = ?");
    this.stmtClear = db.prepare("DELETE FROM worker_loops WHERE id = ?");
    this.stmtDeleteByWorker = db.prepare("DELETE FROM worker_loops WHERE worker_id = ?");
  }

  insert(input: InsertLoopInput): void {
    this.stmtInsert.run(
      input.id,
      input.workerId,
      input.parentId,
      safeStringify(input.goal),
      input.strategy,
      input.maxAttempts,
      input.startedAt,
      input.updatedAt,
    );
  }

  findById(id: string): LoopRow | null {
    const r = this.stmtFindById.get(id) as Row | undefined;
    return r ? toLoopRow(r) : null;
  }

  findActiveByWorker(workerId: string): LoopRow | null {
    const r = this.stmtFindActiveByWorker.get(workerId) as Row | undefined;
    return r ? toLoopRow(r) : null;
  }

  findAnyByWorker(workerId: string): LoopRow | null {
    const r = this.stmtFindAnyByWorker.get(workerId) as Row | undefined;
    return r ? toLoopRow(r) : null;
  }

  listActive(): LoopRow[] {
    return (this.stmtListActive.all() as Row[]).map(toLoopRow);
  }

  setStatus(id: string, status: LoopStatus): void {
    this.stmtSetStatus.run(status, Date.now(), id);
  }

  amend(id: string, patch: LoopAmendPatch): void {
    const cur = this.findById(id);
    if (!cur) return;
    const goal = patch.goal ?? cur.goal;
    const strategy = patch.strategy ?? cur.strategy;
    // maxAttempts is present-with-null to force unbounded, so distinguish absent
    // (keep) from an explicit null via the key, not a nullish check.
    const maxAttempts = "maxAttempts" in patch ? (patch.maxAttempts ?? null) : cur.maxAttempts;
    this.stmtAmend.run(safeStringify(goal), strategy, maxAttempts, Date.now(), id);
  }

  resetProgress(id: string): void {
    this.stmtResetProgress.run(Date.now(), id);
  }

  setCheckFailures(id: string, n: number): void {
    this.stmtSetCheckFailures.run(n, Date.now(), id);
  }

  recordAttempt(id: string, attempt: LoopAttempt): void {
    const cur = this.findById(id);
    if (!cur) return;
    const ring = [...cur.progressRing, attempt].slice(-PROGRESS_RING_CAP);
    this.stmtRecordAttempt.run(safeStringify(ring), attempt.reason, Date.now(), id);
  }

  setHeldReport(id: string, text: string | null): void {
    if (text === null) this.stmtClearHeld.run(Date.now(), id);
    else this.stmtSetHeldReport.run(text, Date.now(), id);
  }

  setHeldOutput(id: string, output: StepHeldOutput | null): void {
    this.stmtSetHeldOutput.run(output === null ? null : safeStringify(output), Date.now(), id);
  }

  setAwaitingInput(id: string, awaiting: boolean): void {
    this.stmtSetAwaitingInput.run(awaiting ? 1 : 0, Date.now(), id);
  }

  clear(id: string): void {
    this.stmtClear.run(id);
  }

  deleteByWorker(workerId: string): void {
    this.stmtDeleteByWorker.run(workerId);
  }
}
