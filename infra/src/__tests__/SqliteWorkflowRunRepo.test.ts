import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteWorkflowRunRepo } from "../persistence/SqliteWorkflowRunRepo.ts";
import { runMigrations } from "../persistence/MigrationRunner.ts";
import type { WorkflowRun } from "../../../contracts/src/workflow.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

// Build the canonical parsed-DTO shape: an absent optional (args/result) is the
// key omitted, not present-with-undefined — that's what the adapter returns.
function run(id: string, over: Partial<WorkflowRun> = {}): WorkflowRun {
  const row: WorkflowRun = {
    id,
    definitionName: "review",
    owner: "orch-1",
    anchorId: `anchor-${id}`,
    status: "running",
    args: { target: "src/", count: 3 },
    startedAt: 1000,
    updatedAt: 1000,
    ...over,
  };
  if (row.args === undefined) delete row.args;
  if (row.result === undefined) delete row.result;
  return row;
}

let db: DatabaseSync;
let repo: SqliteWorkflowRunRepo;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wfr-test-"));
  db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteWorkflowRunRepo(db);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("migration 052_workflow_runs", () => {
  it("applies cleanly and creates the workflow_runs table", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_runs'")
      .get() as { name: string } | undefined;
    assert.equal(row?.name, "workflow_runs");
  });
});

describe("SqliteWorkflowRunRepo round-trip", () => {
  it("insert → findById returns an equal DTO (every field round-trips)", () => {
    const r = run("r-1");
    repo.insert(r);
    assert.deepEqual(repo.findById("r-1"), r);
  });

  it("round-trips a null definitionName and an absent args/result", () => {
    const r = run("r-2", { definitionName: null, args: undefined, result: undefined });
    repo.insert(r);
    const found = repo.findById("r-2");
    assert.ok(found);
    assert.equal(found.definitionName, null);
    assert.equal(found.args, undefined);
    assert.equal(found.result, undefined);
    assert.deepEqual(found, r);
  });

  it("findById returns null for an unknown id", () => {
    assert.equal(repo.findById("nope"), null);
  });

  it("listActive returns only pending/running, ordered by started_at", () => {
    repo.insert(run("r-pending", { status: "pending", startedAt: 1 }));
    repo.insert(run("r-running", { status: "running", startedAt: 2 }));
    repo.insert(run("r-passed", { status: "passed", startedAt: 3 }));
    repo.insert(run("r-failed", { status: "failed", startedAt: 4 }));
    repo.insert(run("r-stopped", { status: "stopped", startedAt: 5 }));

    assert.deepEqual(repo.listActive().map((x) => x.id), ["r-pending", "r-running"]);
  });

  it("listByOwner scopes to the owner", () => {
    repo.insert(run("a", { owner: "orch-1", startedAt: 1 }));
    repo.insert(run("b", { owner: "orch-1", startedAt: 2 }));
    repo.insert(run("c", { owner: "orch-2", startedAt: 3 }));

    assert.deepEqual(repo.listByOwner("orch-1").map((x) => x.id), ["a", "b"]);
    assert.deepEqual(repo.listByOwner("orch-2").map((x) => x.id), ["c"]);
    assert.deepEqual(repo.listByOwner("orch-none"), []);
  });

  it("setStatus moves a run out of active", () => {
    repo.insert(run("r-1", { status: "running" }));
    repo.setStatus("r-1", "passed");
    assert.equal(repo.findById("r-1")?.status, "passed");
    assert.deepEqual(repo.listActive(), []);
  });

  it("setResult persists the parsed result", () => {
    repo.insert(run("r-1", { result: undefined }));
    repo.setResult("r-1", { confirmed: ["bug-a", "bug-b"] });
    assert.deepEqual(repo.findById("r-1")?.result, { confirmed: ["bug-a", "bug-b"] });
  });

  it("survives a restart — a second adapter over the same db file sees the first's rows", () => {
    const dbFile = join(tmp, "state.db");
    const db1 = new DatabaseSync(dbFile);
    runMigrations(db1, noopLog as never);
    new SqliteWorkflowRunRepo(db1).insert(run("r-1"));
    db1.close();

    const db2 = new DatabaseSync(dbFile);
    runMigrations(db2, noopLog as never);
    const found = new SqliteWorkflowRunRepo(db2).findById("r-1");
    db2.close();
    assert.deepEqual(found, run("r-1"));
  });

  it("skips a row with corrupt args_json instead of throwing", () => {
    repo.insert(run("good", { startedAt: 1 }));
    db.prepare(
      `INSERT INTO workflow_runs (id, definition_name, owner, anchor_id, status, args_json, result_json, started_at, updated_at)
       VALUES (?, NULL, 'orch-1', 'a', 'running', ?, NULL, 2, 2)`,
    ).run("broken", "not json{");

    assert.deepEqual(repo.listActive().map((x) => x.id), ["good"]);
    assert.equal(repo.findById("broken"), null);
  });
});
