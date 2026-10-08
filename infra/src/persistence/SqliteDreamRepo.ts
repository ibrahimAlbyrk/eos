// SqliteDreamRepo — dream_runs (one JSON row per run, re-validated on read),
// dream_watermarks and dream_exclusions (migration 061), dream_candidates (one JSON
// row per ledger candidate, migration 063).

import type { DatabaseSync } from "node:sqlite";
import {
  DreamCandidateSchema, DreamRunSchema, type DreamCandidate, type DreamRun,
} from "../../../contracts/src/dream.ts";
import type { DreamRepo } from "../../../core/src/ports/DreamRepo.ts";
import { withTransaction } from "./transaction.ts";

export class SqliteDreamRepo implements DreamRepo {
  private readonly stmtSave;
  private readonly stmtGet;
  private readonly stmtList;
  private readonly stmtWatermark;
  private readonly stmtSetWatermark;
  private readonly stmtExcluded;
  private readonly stmtExclude;
  private readonly stmtInclude;
  private readonly stmtCandidates;
  private readonly stmtClearCandidates;
  private readonly stmtPutCandidate;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.stmtSave = db.prepare(
      "INSERT INTO dream_runs (id, started_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
    );
    this.stmtGet = db.prepare("SELECT data FROM dream_runs WHERE id = ?");
    this.stmtList = db.prepare("SELECT data FROM dream_runs ORDER BY started_at DESC LIMIT ?");
    this.stmtWatermark = db.prepare("SELECT last_event_id AS id FROM dream_watermarks WHERE worker_id = ?");
    this.stmtSetWatermark = db.prepare(
      "INSERT INTO dream_watermarks (worker_id, last_event_id) VALUES (?, ?) ON CONFLICT(worker_id) DO UPDATE SET last_event_id = excluded.last_event_id",
    );
    this.stmtExcluded = db.prepare("SELECT worker_id AS id FROM dream_exclusions");
    this.stmtExclude = db.prepare("INSERT INTO dream_exclusions (worker_id) VALUES (?) ON CONFLICT(worker_id) DO NOTHING");
    this.stmtInclude = db.prepare("DELETE FROM dream_exclusions WHERE worker_id = ?");
    this.stmtCandidates = db.prepare("SELECT data FROM dream_candidates ORDER BY last_seen DESC");
    this.stmtClearCandidates = db.prepare("DELETE FROM dream_candidates");
    this.stmtPutCandidate = db.prepare("INSERT INTO dream_candidates (id, last_seen, data) VALUES (?, ?, ?)");
  }

  save(run: DreamRun): void {
    const parsed = DreamRunSchema.parse(run);
    this.stmtSave.run(parsed.id, parsed.startedAt, JSON.stringify(parsed));
  }

  get(id: string): DreamRun | null {
    return parseRun(this.stmtGet.get(id));
  }

  list(limit: number): DreamRun[] {
    return this.stmtList.all(limit).map(parseRun).filter((r): r is DreamRun => r !== null);
  }

  latest(): DreamRun | null {
    return this.list(1)[0] ?? null;
  }

  watermark(workerId: string): number {
    const row = this.stmtWatermark.get(workerId) as { id: number } | undefined;
    return row?.id ?? 0;
  }

  setWatermark(workerId: string, eventId: number): void {
    this.stmtSetWatermark.run(workerId, eventId);
  }

  excluded(): string[] {
    return (this.stmtExcluded.all() as { id: string }[]).map((r) => r.id);
  }

  setExcluded(workerId: string, excluded: boolean): void {
    if (excluded) this.stmtExclude.run(workerId);
    else this.stmtInclude.run(workerId);
  }

  candidates(): DreamCandidate[] {
    return this.stmtCandidates.all().map((row) => parseRow(row, DreamCandidateSchema)).filter((c): c is DreamCandidate => c !== null);
  }

  replaceCandidates(candidates: readonly DreamCandidate[]): void {
    const parsed = candidates.map((c) => DreamCandidateSchema.parse(c));
    withTransaction(this.db, () => {
      this.stmtClearCandidates.run();
      for (const c of parsed) this.stmtPutCandidate.run(c.id, c.lastSeen, JSON.stringify(c));
    });
  }
}

function parseRun(row: unknown): DreamRun | null {
  return parseRow(row, DreamRunSchema);
}

// A row that no longer validates (an older shape) is skipped, never fatal.
function parseRow<T>(row: unknown, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): T | null {
  const data = (row as { data?: string } | undefined)?.data;
  if (!data) return null;
  try {
    const r = schema.safeParse(JSON.parse(data));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
